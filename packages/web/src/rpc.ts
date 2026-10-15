import { CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BBox } from "@sinapsi/shared";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { SERVER_HOST } from "./collab";
import { elementBBox, findFreeSpot } from "./geometry";

const WS = location.protocol === "https:" ? "wss" : "ws";

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Msg =
  | { id: string; type: "export"; elementIds: string[] | null; padding: number; maxSize: number }
  | { id: string; type: "mermaid"; mermaid: string; anchor: BBox | null; nodeId: string | null };

async function exportImage(api: ExcalidrawImperativeAPI, msg: Extract<Msg, { type: "export" }>) {
  const wanted = msg.elementIds ? new Set(msg.elementIds) : null;
  const elements = api.getSceneElements().filter((e) => !wanted || wanted.has(e.id));
  if (!elements.length) throw new Error("niente da disegnare");
  const blob = await exportToBlob({
    elements,
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
    files: api.getFiles(),
    mimeType: "image/png",
    exportPadding: msg.padding,
    maxWidthOrHeight: msg.maxSize,
  });
  const bitmap = await createImageBitmap(blob);
  // Where pixel (0,0) is on the board and how many pixels per scene unit:
  // lets the agent point at regions of the image (e.g. to split a node).
  const [minX, minY, maxX] = getCommonBounds(elements);
  const scale = bitmap.width / (maxX - minX + 2 * msg.padding);
  const out = {
    data: await toBase64(blob),
    width: bitmap.width,
    height: bitmap.height,
    originX: minX - msg.padding,
    originY: minY - msg.padding,
    scale,
  };
  bitmap.close();
  return out;
}

const validIndex = (i: string | null | undefined): i is string => {
  if (!i) return false;
  try {
    generateKeyBetween(i, null);
    return true;
  } catch {
    return false;
  }
};

/** Mermaid → editable Excalidraw shapes, placed in free space near the anchor, marked as AI. */
async function drawMermaid(api: ExcalidrawImperativeAPI, msg: Extract<Msg, { type: "mermaid" }>) {
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const { elements: skeleton } = await parseMermaidToExcalidraw(msg.mermaid, { themeVariables: { fontSize: "16px" } });
  const converted = convertToExcalidrawElements(skeleton as ExcalidrawElementSkeleton[], { regenerateIds: true });
  if (!converted.length) throw new Error("diagramma vuoto");
  const [minX, minY, maxX, maxY] = getCommonBounds(converted);
  const scene = api.getSceneElementsIncludingDeleted();
  const occupied = scene.filter((e) => !e.isDeleted).map((e) => elementBBox(e as Parameters<typeof elementBBox>[0]));
  const spot = findFreeSpot(occupied, maxX - minX, maxY - minY, msg.anchor ?? undefined);
  const last = scene
    .map((e) => e.index)
    .filter(validIndex)
    .sort()
    .pop();
  const keys = generateNKeysBetween(last ?? null, null, converted.length);
  const placed = converted.map(
    (e, i) =>
      ({
        ...e,
        x: e.x + spot.x - minX,
        y: e.y + spot.y - minY,
        index: keys[i],
        customData: { ...e.customData, sinapsi: { author: "ai", ...(msg.nodeId ? { nodeId: msg.nodeId } : {}) } },
      }) as unknown as ExcalidrawElement,
  );
  // AI drawings are not part of anyone's undo history.
  api.updateScene({ elements: [...scene, ...placed], captureUpdate: CaptureUpdateAction.NEVER });
  return { elementIds: placed.map((e) => e.id), bbox: { x: spot.x, y: spot.y, w: maxX - minX, h: maxY - minY } };
}

/**
 * Lends this tab to the server for work that needs a real DOM: rasterizing
 * the board for the agent's eyes and turning Mermaid into drawn shapes.
 */
export function startRenderer(board: string, getApi: () => ExcalidrawImperativeAPI | null) {
  let ws: WebSocket | null = null;
  let retry = 500;
  let stopped = false;

  const connect = () => {
    ws = new WebSocket(`${WS}://${SERVER_HOST}/rpc/${encodeURIComponent(board)}`);
    ws.onopen = () => {
      retry = 500;
    };
    ws.onclose = () => {
      if (stopped) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
    };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data as string) as Msg;
      const reply = (payload: Record<string, unknown>) => ws?.send(JSON.stringify({ id: msg.id, ...payload }));
      try {
        const api = getApi();
        if (!api) throw new Error("lavagna non pronta");
        const result = msg.type === "mermaid" ? await drawMermaid(api, msg) : await exportImage(api, msg);
        reply({ ok: true, ...result });
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
  };
  connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}
