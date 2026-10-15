/**
 * Runs the geometric pre-pass offline on a saved board and prints the result.
 *
 *   tsx scripts/segment-debug.ts [board=main] [--svg out.svg]
 *
 * --svg draws every candidate's elements in its own color, links dashed: the
 * quickest way to see what the segmenter thinks belongs together.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Candidate, DOC } from "@sinapsi/shared";
import * as Y from "yjs";
import { DATA_DIR } from "../src/config";
import { type El, elementBBox, segment } from "../src/segment";

const args = process.argv.slice(2);
const svgIdx = args.indexOf("--svg");
const svgOut = svgIdx >= 0 ? args.splice(svgIdx, 2)[1] : undefined;
const board = args[0] ?? "main";

const doc = new Y.Doc();
Y.applyUpdate(doc, readFileSync(join(DATA_DIR, `${board}.ydoc`)));
const elements = [...doc.getMap<El>(DOC.elements).values()];
const cands = segment(elements, new Map(), Date.now());

const shapes = cands.filter((c) => c.kind !== "link");
const links = cands.filter((c) => c.kind === "link");
console.log(`${elements.filter((e) => !e.isDeleted).length} elementi vivi → ${shapes.length} candidati, ${links.length} link\n`);
for (const c of shapes.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
  const b = c.bbox;
  console.log(`${c.id.padEnd(28)} ${c.kind.padEnd(8)} ${String(c.elementIds.length).padStart(3)} el  @${b.x},${b.y} ${b.w}×${b.h}  ${c.summary.replace(/\n/g, " / ").slice(0, 60)}`);
}
for (const l of links) console.log(`link ${l.id}: ${l.from} → ${l.to} (${l.elementIds.length} el)`);

if (svgOut) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const owner = new Map<string, Candidate>();
  for (const c of cands) for (const id of c.elementIds) owner.set(id, c);
  const palette = ["#e03131", "#1971c2", "#2f9e44", "#f08c00", "#7048e8", "#0c8599", "#d6336c", "#5c940d", "#e8590c", "#3b5bdb"];
  const color = new Map(shapes.map((c, i) => [c.id, palette[i % palette.length]]));
  const live = elements.filter((e) => !e.isDeleted);
  const boxes = live.map(elementBBox);
  const minX = Math.min(...boxes.map((b) => b.x)) - 20;
  const minY = Math.min(...boxes.map((b) => b.y)) - 20;
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 20;
  const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 20;
  const parts: string[] = [];
  for (const e of live) {
    const c = owner.get(e.id);
    const stroke = c ? (c.kind === "link" ? "#adb5bd" : color.get(c.id)) : "#000";
    const dash = c?.kind === "link" ? ' stroke-dasharray="6 4"' : "";
    if (e.points?.length) {
      const d = e.points.map(([x, y], i) => `${i ? "L" : "M"}${(e.x + x).toFixed(1)},${(e.y + y).toFixed(1)}`).join(" ");
      parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="3"${dash}/>`);
    } else if (e.type === "text") {
      parts.push(`<text x="${e.x}" y="${e.y + 16}" font-size="16" fill="${stroke}">${(e.text ?? "").replace(/[<&]/g, "")}</text>`);
    } else {
      parts.push(`<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" fill="none" stroke="${stroke}" stroke-width="2"${dash}/>`);
    }
  }
  for (const c of shapes) {
    const b = c.bbox;
    parts.push(`<rect x="${b.x - 4}" y="${b.y - 4}" width="${b.w + 8}" height="${b.h + 8}" fill="none" stroke="${color.get(c.id)}" stroke-width="1" opacity="0.5"/>`);
  }
  void byId;
  writeFileSync(
    svgOut,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" width="${Math.round((maxX - minX) * 0.8)}" style="background:#fff">${parts.join("")}</svg>`,
  );
  console.log(`\nSVG → ${svgOut}`);
}
