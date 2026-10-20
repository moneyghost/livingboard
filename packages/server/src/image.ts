import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type BoardFile, MAX_IMAGE_BYTES } from "@livingboard/shared";

export interface LoadedImage {
  file: BoardFile;
  width: number;
  height: number;
}

type Sniffed = { mimeType: string; width: number; height: number };

/** Recognise an image by its bytes (never by name) and read its pixel size from the header. */
export function sniffImage(buf: Buffer): Sniffed | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { mimeType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 4) === "GIF8") {
    return { mimeType: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return sniffJpeg(buf);
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { mimeType: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { mimeType: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  const head = buf.toString("utf8", 0, Math.min(buf.length, 2048)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return sniffSvg(buf.toString("utf8"));
  return null;
}

function sniffJpeg(buf: Buffer): Sniffed | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // Standalone markers and fill bytes carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    // SOF0..SOF15 (except DHT, JPG, DAC) hold the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mimeType: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function sniffSvg(text: string): Sniffed {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const px = (v?: string) => (v && /^\s*[\d.]+\s*(px)?\s*$/.test(v) ? Number.parseFloat(v) : undefined);
  const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = vb && vb.length === 4 && vb.every(Number.isFinite) ? [vb[2], vb[3]] : [undefined, undefined];
  return { mimeType: "image/svg+xml", width: px(attr("width")) ?? vw ?? 300, height: px(attr("height")) ?? vh ?? 150 };
}

export type ImageSource = { path?: string; url?: string; data?: string };

/**
 * Load an image the agent wants on the board. `path` reads this computer's
 * disk, so it is only honoured for agents on the same machine (`allowPath`):
 * the MCP endpoint is reachable from the LAN in `--lan` mode. Whatever the
 * source, only real images (checked by their bytes) get through.
 */
export async function loadImage(src: ImageSource, opts: { allowPath: boolean }): Promise<LoadedImage> {
  const given = [src.path, src.url, src.data].filter((v) => v !== undefined).length;
  if (given !== 1) throw new Error("Passa una sola sorgente: path, url oppure data (base64).");
  let buf: Buffer;
  if (src.path !== undefined) {
    if (!opts.allowPath) throw new Error("path funziona solo se l'agente gira sullo stesso computer del server: usa url o data (base64).");
    const file = resolve(src.path);
    const size = statSync(file).size;
    if (size > MAX_IMAGE_BYTES) throw new Error(tooBig(size));
    buf = readFileSync(file);
  } else if (src.url !== undefined) {
    const url = new URL(src.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Solo url http o https.");
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!res.ok) throw new Error(`${url.href}: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error(tooBig(declared));
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = Buffer.from(src.data!.replace(/^data:[^,]*,/, ""), "base64");
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(tooBig(buf.length));
  const info = sniffImage(buf);
  if (!info || !info.width || !info.height) throw new Error("Non è un'immagine supportata (PNG, JPEG, GIF, WebP o SVG).");
  // Same id scheme as Excalidraw (hash of the content): the same picture is stored once.
  const id = createHash("sha1").update(buf).digest("hex");
  return {
    file: { id, mimeType: info.mimeType, dataURL: `data:${info.mimeType};base64,${buf.toString("base64")}`, created: Date.now() },
    width: info.width,
    height: info.height,
  };
}

const tooBig = (bytes: number) =>
  `Immagine troppo grande (${(bytes / 1024 / 1024).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / 1024 / 1024} MB): ridimensionala o comprimila.`;
