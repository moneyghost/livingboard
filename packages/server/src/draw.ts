import { AI_COLOR, type BBox, type SinapsiElementData, uid } from "@sinapsi/shared";
import { generateKeyBetween } from "fractional-indexing";
import { type El, elementBBox } from "./segment";
import type { Paint, Pt, Scene, SceneItem } from "./svgpath";

/**
 * Builds real Excalidraw elements for the agent. The agent describes *what* to
 * draw ("a sticky next to node X", "a sketch of a lamp", "continue this tree");
 * this module decides *where*, so the model never juggles coordinates and never
 * covers what people drew.
 */

export type DrawItem = {
  type: "box" | "ellipse" | "diamond" | "sticky" | "text" | "arrow";
  text?: string;
  /** Place next to this node/candidate/element id (or "$n" = n-th item of this call). */
  near?: string;
  at?: { x: number; y: number };
  /** For arrows: endpoints (node/candidate/element id or "$n"). */
  from?: string;
  to?: string;
  color?: string;
};

export type AnnotationKind = "circle" | "underline" | "highlight" | "check" | "cross" | "callout";
export type Direction = "down" | "right" | "up" | "left";

/** Words per element: the board shows ideas, not paragraphs (long prose goes to the Document). */
export const MAX_WORDS = 20;

const STICKY_BG = "#ffe8cc";
const HIGHLIGHT = "#ffec99";
const FONT_SIZE = 20;
const NOTE_FONT = 16;
const GAP = 60;

const rand = () => Math.floor(Math.random() * 2 ** 31);
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const HEX = /^#[0-9a-f]{3,8}$/i;

export function checkWords(text: string | undefined, max = MAX_WORDS) {
  if (text && words(text) > max) {
    throw new Error(
      `Troppo testo in un elemento (${words(text)} parole, max ${max}). Spezzalo: una tabella (draw_table), più elementi, un disegno (draw_svg); le spiegazioni lunghe vanno nel Documento (write_doc).`,
    );
  }
}

function validIndex(i: string) {
  try {
    generateKeyBetween(i, null);
    return true;
  } catch {
    return false;
  }
}

function measure(text: string, fontSize = FONT_SIZE) {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  // Excalifont is wide: overestimate so containers never clip (the client re-measures anyway).
  return { w: Math.ceil(longest * fontSize * 0.62), h: Math.ceil(lines.length * fontSize * 1.25) };
}

function wrap(text: string, max = 24): string {
  return text
    .split("\n")
    .map((line) => {
      const ws = line.split(/\s+/);
      const out: string[] = [];
      let cur = "";
      for (const w of ws) {
        if ((cur + " " + w).trim().length > max && cur) {
          out.push(cur);
          cur = w;
        } else cur = (cur + " " + w).trim();
      }
      if (cur) out.push(cur);
      return out.join("\n");
    })
    .join("\n");
}

const center = (b: BBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

type P = { x: number; y: number };

/** Does segment p→q cross the rectangle (shrunk a little, so grazing an edge is fine)? Liang–Barsky. */
export function segmentHitsRect(p: P, q: P, r: BBox, shrink = 4): boolean {
  const x0 = r.x + shrink;
  const y0 = r.y + shrink;
  const x1 = r.x + r.w - shrink;
  const y1 = r.y + r.h - shrink;
  if (x1 <= x0 || y1 <= y0) return false;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (pp: number, qq: number) => {
    if (pp === 0) return qq >= 0;
    const t = qq / pp;
    if (pp < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, p.x - x0) && clip(dx, x1 - p.x) && clip(-dy, p.y - y0) && clip(dy, y1 - p.y);
}

function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Is `r` (mostly) part of one of `boxes`? Used to ignore an arrow's own endpoints. */
function within(r: BBox, boxes: BBox[]) {
  return boxes.some((b) => {
    const w = Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x);
    const h = Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y);
    return w > 0 && h > 0 && w * h >= 0.6 * Math.max(1, r.w * r.h);
  });
}

const rectsOverlap = (a: BBox, b: BBox, pad: number) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

export class Drawer {
  private occupied: BBox[];
  /** Paths of arrows drawn in this call: later items avoid sitting on them. */
  private lines: P[][] = [];
  private sortedIndices: string[];
  private index: string | null;
  readonly created: Record<string, unknown>[] = [];
  private refs: BBox[] = [];

  constructor(
    private elements: El[],
    private resolveRef: (ref: string) => BBox | undefined,
    private meta: SinapsiElementData,
    private style: { color?: string; fontSize?: number } = {},
  ) {
    const live = elements.filter((e) => !e.isDeleted);
    // Arrows and lines are paths, not areas: text must not sit on them, but they don't block a region.
    const linear = (e: El) => (e.type === "arrow" || e.type === "line") && !!e.points?.length;
    this.occupied = live.filter((e) => !linear(e)).map(elementBBox);
    this.lines = live.filter(linear).map((e) => e.points!.map(([x, y]) => ({ x: e.x + x, y: e.y + y })));
    this.sortedIndices = elements
      .map((e) => e.index)
      .filter((i): i is string => !!i && validIndex(i))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.index = this.sortedIndices[this.sortedIndices.length - 1] ?? null;
  }

  /** The id every element of this call shares: what the agent passes to replace or erase it later. */
  get drawingId() {
    return this.meta.drawingId;
  }

  private get color() {
    return this.style.color ?? AI_COLOR;
  }

  private nextIndex() {
    this.index = generateKeyBetween(this.index, null);
    return this.index;
  }

  /** An index just below the given elements, so a highlight sits behind them. */
  private indexBelow(elementIds: string[]): string {
    const mine = elementIds
      .map((id) => this.elements.find((e) => e.id === id)?.index)
      .filter((i): i is string => !!i && validIndex(i))
      .sort();
    const first = mine[0];
    if (!first) return this.nextIndex();
    const pos = this.sortedIndices.indexOf(first);
    const below = pos > 0 ? this.sortedIndices[pos - 1] : null;
    return generateKeyBetween(below, first);
  }

  private ref(ref: string | undefined): BBox | undefined {
    if (!ref) return undefined;
    const m = /^\$(\d+)$/.exec(ref);
    if (m) return this.refs[Number(m[1])];
    return this.resolveRef(ref);
  }

  /** How many things (other than `ignore`, its endpoints) the polyline runs over, with a small margin. */
  private pathHits(points: P[], ignore: BBox[], extra: BBox[] = []) {
    const obstacles = [...this.occupied.filter((o) => !within(o, ignore)), ...extra];
    let hits = 0;
    for (const o of obstacles) {
      for (let i = 1; i < points.length; i++) {
        if (segmentHitsRect(points[i - 1], points[i], o, -10)) {
          hits++;
          break;
        }
      }
    }
    return hits;
  }

  private pathClear(points: P[], ignore: BBox[], extra: BBox[] = []) {
    return this.pathHits(points, ignore, extra) === 0;
  }

  /** How many existing arrows/lines the polyline crosses. */
  private crossings(points: P[]) {
    let n = 0;
    for (const line of this.lines)
      for (let i = 1; i < points.length; i++)
        for (let j = 1; j < line.length; j++) if (segmentsCross(points[i - 1], points[i], line[j - 1], line[j])) n++;
    return n;
  }

  /** Arrow with any number of points (2 = straight, 3 = curve or elbow). */
  private polyArrow(points: P[], color: string, curved: boolean, extra: Record<string, unknown> = {}) {
    const p0 = points[0];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return this.base(
      "arrow",
      { x: p0.x, y: p0.y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
      color,
      {
        points: points.map((p) => [p.x - p0.x, p.y - p0.y]),
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
        roundness: curved ? { type: 2 } : null,
        ...extra,
      },
    );
  }

  /**
   * Route an arrow between two boxes so it doesn't run over anything: straight
   * if the way is clear, otherwise a curve bending further and further, or an
   * elbow; straight anyway as a last resort.
   */
  private route(a: BBox, b: BBox): { points: P[]; curved: boolean } {
    const [p, q] = connect(a, b);
    const ends = [a, b];
    if (this.pathClear([p, q], ends)) return { points: [p, q], curved: false };
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const nx = -(q.y - p.y) / len;
    const ny = (q.x - p.x) / len;
    for (const k of [50, -50, 100, -100, 160, -160, 240, -240]) {
      const m = { x: mid.x + nx * k, y: mid.y + ny * k };
      if (this.pathClear([p, m, q], ends)) return { points: [p, m, q], curved: true };
    }
    for (const corner of [
      { x: q.x, y: p.y },
      { x: p.x, y: q.y },
    ]) {
      if (this.pathClear([p, corner, q], ends)) return { points: [p, corner, q], curved: false };
    }
    return { points: [p, q], curved: false };
  }

  private overlaps(b: BBox, pad = 20) {
    if (this.occupied.some((o) => rectsOverlap(o, b, pad))) return true;
    const grown = { x: b.x - pad / 2, y: b.y - pad / 2, w: b.w + pad, h: b.h + pad };
    return this.lines.some((pts) => pts.some((pt, i) => i > 0 && segmentHitsRect(pts[i - 1], pt, grown, 0)));
  }

  /** First free slot around the anchor: right, below, left, above, sliding down when busy. */
  place(w: number, h: number, anchor?: BBox, at?: { x: number; y: number }): BBox {
    if (at) return { x: at.x, y: at.y, w, h };
    if (!anchor) {
      if (this.occupied.length === 0) return { x: 0, y: 0, w, h };
      const maxX = Math.max(...this.occupied.map((o) => o.x + o.w));
      const minY = Math.min(...this.occupied.map((o) => o.y));
      anchor = { x: maxX + GAP, y: minY, w: 0, h: 0 };
    }
    const tries: [number, number][] = [
      [anchor.x + anchor.w + GAP, anchor.y],
      [anchor.x, anchor.y + anchor.h + GAP],
      [anchor.x - w - GAP, anchor.y],
      [anchor.x, anchor.y - h - GAP],
    ];
    // Nearest first: every side right next to the anchor, then each side a step further down.
    for (let k = 0; k < 8; k++) {
      for (const [x0, y0] of tries) {
        const b = { x: x0, y: y0 + k * (h + 30), w, h };
        if (!this.overlaps(b)) return b;
      }
    }
    return { x: anchor.x + anchor.w + GAP, y: anchor.y + 8 * (h + 30), w, h };
  }

  private claim(b: BBox) {
    this.occupied.push(b);
    this.refs.push(b);
  }

  private base(type: string, b: BBox, color: string, extra: Record<string, unknown> = {}) {
    const ghost = !!this.meta.ghost;
    return {
      id: uid("ai_"),
      type,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      angle: 0,
      strokeColor: color,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: ghost ? "dashed" : "solid",
      roughness: 1,
      opacity: ghost ? 45 : 100,
      groupIds: [],
      frameId: null,
      index: this.nextIndex(),
      roundness: type === "rectangle" ? { type: 3 } : type === "diamond" ? { type: 2 } : null,
      seed: rand(),
      version: 1,
      versionNonce: rand(),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      customData: { sinapsi: { ...this.meta } },
      ...extra,
    };
  }

  private text(text: string, b: BBox, color: string, containerId: string | null, fontSize = FONT_SIZE) {
    return this.base("text", b, color, {
      text,
      originalText: text,
      fontSize,
      fontFamily: 5,
      textAlign: containerId ? "center" : "left",
      verticalAlign: containerId ? "middle" : "top",
      containerId,
      autoResize: true,
      lineHeight: 1.25,
    });
  }

  /** A polyline with absolute points as a hand-drawn freedraw stroke. */
  private stroke(points: Pt[], color: string, width = 1) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [x0, y0] = points[0];
    return this.base(
      "freedraw",
      { x: x0, y: y0, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
      color,
      {
        points: points.map(([x, y]) => [x - x0, y - y0]),
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: null,
        strokeWidth: width,
      },
    );
  }

  private line(p: { x: number; y: number }, q: { x: number; y: number }, color: string, extra: Record<string, unknown> = {}) {
    return this.base("arrow", { x: p.x, y: p.y, w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) }, color, {
      points: [
        [0, 0],
        [q.x - p.x, q.y - p.y],
      ],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
      ...extra,
    });
  }

  private arrowBetween(a: BBox, b: BBox, color: string, label?: string, extra: Record<string, unknown> = {}) {
    const { points, curved } = this.route(a, b);
    this.arrowAlong(points, curved, color, label, extra);
  }

  /** Draw an arrow on a given path; its label only if it fits without covering anything. */
  private arrowAlong(points: P[], curved: boolean, color: string, label?: string, extra: Record<string, unknown> = {}, avoid: BBox[] = []) {
    const arrow = this.polyArrow(points, color, curved, extra);
    this.created.push(arrow);
    if (label) {
      checkWords(label, 4);
      const t = wrap(label, 16);
      const m = measure(t, 14);
      const mid = points.length === 3 ? points[1] : { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const box = { x: mid.x - m.w / 2, y: mid.y - m.h / 2, ...m };
      const free = !this.occupied.some((o) => rectsOverlap(o, box, 4)) && !avoid.some((o) => rectsOverlap(o, box, 4));
      if (free) {
        const lt = this.text(t, box, color, arrow.id, 14);
        (arrow as Record<string, unknown>).boundElements = [{ type: "text", id: lt.id }];
        this.created.push(lt);
        this.occupied.push(box);
      }
    }
    // Arrows are obstacles for what comes next (text placed later must not sit on them).
    this.lines.push(points);
    return arrow;
  }

  // ------------------------------------------------------------- basic items

  add(item: DrawItem) {
    checkWords(item.text);
    const color = item.color ?? this.color;
    if (item.type === "arrow") {
      const a = this.ref(item.from);
      const b = this.ref(item.to);
      if (!a || !b) throw new Error(`Freccia: estremi non trovati (${item.from} → ${item.to})`);
      this.arrowBetween(a, b, color, item.text);
      this.refs.push(unionOf(a, b));
      return;
    }

    const text = item.text ? wrap(item.text) : "";
    const m = measure(text || " ");
    if (item.type === "text") {
      const b = this.place(m.w, m.h, this.ref(item.near), item.at);
      this.created.push(this.text(text, b, color, null));
      this.claim(b);
      return;
    }

    const shapeType = item.type === "box" || item.type === "sticky" ? "rectangle" : item.type;
    const w = Math.max(m.w + 48, item.type === "sticky" ? 180 : 160);
    const h = Math.max(m.h + 36, item.type === "sticky" ? 110 : 70);
    const b = this.place(w, h, this.ref(item.near), item.at);
    const shape = this.base(shapeType, b, color, {
      backgroundColor: item.type === "sticky" ? STICKY_BG : "transparent",
    });
    this.created.push(shape);
    if (text) {
      const t = this.text(text, { x: b.x + (w - m.w) / 2, y: b.y + (h - m.h) / 2, w: m.w, h: m.h }, color, shape.id);
      (shape as Record<string, unknown>).boundElements = [{ type: "text", id: t.id }];
      this.created.push(t);
    }
    this.claim(b);
  }

  // ------------------------------------------------------------- margin notes

  /**
   * A short note in the margin: to the right of everything drawn at the same
   * height, tied to its node by a thin dotted line (or an arrow, for callouts).
   */
  note(anchor: BBox, text: string, pointer = false) {
    checkWords(text, 40);
    const t = wrap(text, 26);
    const m = measure(t, NOTE_FONT);
    const band = this.occupied.filter((o) => o.y < anchor.y + anchor.h + 40 && o.y + o.h > anchor.y - 40);
    const marginX = Math.max(anchor.x + anchor.w, ...band.map((o) => o.x + o.w)) + 70;
    let b = { x: marginX, y: anchor.y, w: m.w, h: m.h };
    for (let k = 0; k < 12 && this.overlaps(b, 12); k++) b = { ...b, y: b.y + m.h + 14 };
    this.created.push(this.text(t, b, AI_COLOR, null, NOTE_FONT));
    const from = { x: anchor.x + anchor.w + 6, y: anchor.y + Math.min(anchor.h / 2, 24) };
    const to = { x: b.x - 10, y: b.y + Math.min(m.h / 2, 12) };
    this.created.push(
      this.line(pointer ? to : from, pointer ? from : to, AI_COLOR, {
        strokeWidth: 1,
        strokeStyle: pointer ? "solid" : "dotted",
        opacity: 70,
        endArrowhead: pointer ? "arrow" : null,
      }),
    );
    this.claim(b);
  }

  // ------------------------------------------------------------- annotations

  /** Mark up something a person drew, without touching it. */
  annotate(anchor: BBox, kind: AnnotationKind, elementIds: string[], text?: string) {
    const c = AI_COLOR;
    const jitter = () => (Math.random() - 0.5) * 3;
    switch (kind) {
      case "circle": {
        const b = { x: anchor.x - 18, y: anchor.y - 14, w: anchor.w + 36, h: anchor.h + 28 };
        this.created.push(this.base("ellipse", b, c, { roughness: 2, strokeWidth: 2 }));
        break;
      }
      case "underline": {
        const y = anchor.y + anchor.h + 8;
        const pts: Pt[] = [];
        for (let i = 0; i <= 12; i++) pts.push([anchor.x - 4 + ((anchor.w + 8) * i) / 12, y + jitter()]);
        this.created.push(this.stroke(pts, c, 1.5));
        break;
      }
      case "highlight": {
        const b = { x: anchor.x - 8, y: anchor.y - 6, w: anchor.w + 16, h: anchor.h + 12 };
        const el = this.base("rectangle", b, "transparent", {
          backgroundColor: HIGHLIGHT,
          opacity: 55,
          roughness: 0,
          roundness: { type: 3 },
          index: this.indexBelow(elementIds),
        });
        this.created.push(el);
        break;
      }
      case "check":
      case "cross": {
        const x = anchor.x + anchor.w + 10;
        const y = anchor.y - 6;
        if (kind === "check")
          this.created.push(
            this.stroke(
              [
                [x, y + 14],
                [x + 7, y + 22],
                [x + 24, y],
              ],
              "#2f9e44",
              2,
            ),
          );
        else {
          this.created.push(
            this.stroke(
              [
                [x, y],
                [x + 20, y + 20],
              ],
              "#e03131",
              2,
            ),
          );
          this.created.push(
            this.stroke(
              [
                [x + 20, y],
                [x, y + 20],
              ],
              "#e03131",
              2,
            ),
          );
        }
        break;
      }
      case "callout":
        if (!text) throw new Error("Un richiamo ha bisogno di un testo breve.");
        this.note(anchor, text, true);
        return;
    }
    if (text) this.note(anchor, text);
  }

  // ------------------------------------------------------------- scenes (SVG)

  /**
   * Anything the agent can say in SVG, as editable hand-drawn elements: shapes
   * stay shapes, closed paths can be filled, text stays text, markers become
   * arrowheads. Scaled so the longest side is `size` (default: the SVG's own
   * size, kept within 60..900), grouped so it moves as one, placed in free space.
   */
  scene(scene: Scene, opts: { anchor?: BBox; at?: { x: number; y: number }; size?: number; label?: string }) {
    const { items } = scene;
    if (!items.length) throw new Error("L'SVG non contiene niente da disegnare: usa rect, circle, ellipse, line, polyline, polygon, path, text.");
    if (items.length > 400) throw new Error(`SVG troppo complesso (${items.length} elementi, max 400): semplifica.`);
    for (const it of items) if (it.kind === "text") checkWords(it.text, 25);
    checkWords(opts.label);
    const vb = scene.viewBox ?? sceneBounds(items);
    const natural = Math.max(vb.w, vb.h) || 1;
    const k = (opts.size ?? Math.min(900, Math.max(60, natural))) / natural;
    const w = vb.w * k;
    const h = vb.h * k;
    const label = opts.label ? wrap(opts.label, 32) : "";
    const lm = label ? measure(label, NOTE_FONT) : { w: 0, h: 0 };
    const box = this.place(Math.max(w, lm.w), h + (label ? lm.h + 10 : 0), opts.anchor, opts.at);
    const ox = box.x + (box.w - w) / 2;
    const T = ([x, y]: Pt): Pt => [ox + (x - vb.x) * k, box.y + (y - vb.y) * k];
    const groupIds = [uid("g_")];
    for (const it of items) {
      const el = this.sceneItem(it, T, k);
      if (el) this.created.push({ ...el, groupIds });
    }
    if (label) {
      this.created.push({ ...this.text(label, { x: box.x + (box.w - lm.w) / 2, y: box.y + h + 10, ...lm }, this.color, null, NOTE_FONT), groupIds });
    }
    this.claim(box);
  }

  private colorOf(c: string | undefined) {
    if (!c || c === "none") return undefined;
    return c === "currentColor" ? this.color : c;
  }

  /** SVG paint → Excalidraw style. Fill is off unless set; stroke="none" really means no outline. */
  private paint(p: Paint, k: number, filled: boolean) {
    const fill = filled ? this.colorOf(p.fill) : undefined;
    let stroke = this.colorOf(p.stroke);
    if (p.stroke === "none") stroke = "transparent";
    if (!stroke) stroke = fill ?? this.color;
    const ghost = !!this.meta.ghost;
    return {
      strokeColor: stroke,
      backgroundColor: fill ?? "transparent",
      fillStyle: p.fillStyle && FILL_STYLES.has(p.fillStyle) ? p.fillStyle : "solid",
      strokeWidth: Math.round(Math.min(6, Math.max(1, (p.strokeWidth ?? 2) * k)) * 2) / 2,
      strokeStyle: ghost ? "dashed" : (p.dash ?? "solid"),
      opacity: Math.round(Math.max(10, Math.min(1, p.opacity ?? 1) * 100) * (ghost ? 0.45 : 1)),
    };
  }

  private sceneItem(it: SceneItem, T: (p: Pt) => Pt, k: number): Record<string, unknown> | null {
    switch (it.kind) {
      case "rect": {
        const [x, y] = T([it.x, it.y]);
        return this.base("rectangle", { x, y, w: it.w * k, h: it.h * k }, "", {
          ...this.paint(it.paint, k, true),
          roundness: it.rounded ? { type: 3 } : null,
        });
      }
      case "ellipse": {
        const [x, y] = T([it.cx - it.rx, it.cy - it.ry]);
        return this.base("ellipse", { x, y, w: it.rx * 2 * k, h: it.ry * 2 * k }, "", this.paint(it.paint, k, true));
      }
      case "line": {
        const pts = it.points.map(T).filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 0.5);
        if (pts.length < 2) return null;
        const arrow = it.arrowStart || it.arrowEnd;
        let closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1.5;
        // SVG fills an open path as if it were closed.
        if (!arrow && !closed && this.colorOf(it.paint.fill)) {
          pts.push(pts[0]);
          closed = true;
        }
        if (closed) pts[pts.length - 1] = [pts[0][0], pts[0][1]];
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const [x0, y0] = pts[0];
        return this.base(arrow ? "arrow" : "line", { x: x0, y: y0, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, "", {
          ...this.paint(it.paint, k, closed && !arrow),
          points: pts.map(([x, y]) => [x - x0, y - y0]),
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: it.arrowStart ? "arrow" : null,
          endArrowhead: it.arrowEnd ? "arrow" : null,
          ...(arrow ? { elbowed: false } : {}),
        });
      }
      case "text": {
        const size = Math.max(10, Math.round((it.paint.fontSize ?? 16) * k));
        const m = measure(it.text, size);
        const [x, y] = T([it.x, it.y]);
        const align = it.paint.anchor === "middle" ? "center" : it.paint.anchor === "end" ? "right" : "left";
        const left = align === "center" ? x - m.w / 2 : align === "right" ? x - m.w : x;
        // SVG puts y on the baseline of the first line.
        const color = this.colorOf(it.paint.fill) ?? this.colorOf(it.paint.stroke) ?? this.color;
        const el = this.text(it.text, { x: left, y: y - size * 0.95, ...m }, color, null, size);
        return { ...el, textAlign: align, opacity: this.paint(it.paint, k, false).opacity };
      }
    }
  }

  // ------------------------------------------------------------- tables

  /**
   * A hand-drawn table: header row tinted, cells sized to their text, optional
   * highlighted cells (e.g. the recommended option). Grouped, placed in free space.
   */
  table(
    rows: string[][],
    opts: { anchor?: BBox; at?: { x: number; y: number }; title?: string; header?: boolean; highlight?: { row: number; col: number; color?: string }[] },
  ) {
    if (!rows.length || rows.length > 20) throw new Error("La tabella vuole da 1 a 20 righe.");
    const cols = Math.max(...rows.map((r) => r.length));
    if (cols < 1 || cols > 8) throw new Error("La tabella vuole da 1 a 8 colonne.");
    for (const r of rows) for (const c of r) checkWords(c, 12);
    checkWords(opts.title);
    const FS = 16;
    const cells = rows.map((r) => Array.from({ length: cols }, (_, i) => wrap(String(r[i] ?? ""), 22)));
    const colW = Array.from({ length: cols }, (_, i) => Math.max(56, ...cells.map((r) => measure(r[i] || " ", FS).w + 24)));
    const rowH = cells.map((r) => Math.max(36, ...r.map((c) => measure(c || " ", FS).h + 16)));
    const W = colW.reduce((a, b) => a + b, 0);
    const H = rowH.reduce((a, b) => a + b, 0);
    const title = opts.title ? wrap(opts.title, 40) : "";
    const tm = title ? measure(title, 20) : { w: 0, h: 0 };
    const box = this.place(Math.max(W, tm.w), H + (title ? tm.h + 10 : 0), opts.anchor, opts.at);
    const x0 = box.x;
    const y0 = box.y + (title ? tm.h + 10 : 0);
    const colX = colW.map((_, i) => x0 + colW.slice(0, i).reduce((a, b) => a + b, 0));
    const rowY = rowH.map((_, j) => y0 + rowH.slice(0, j).reduce((a, b) => a + b, 0));
    const color = this.color;
    const groupIds = [uid("g_")];
    const push = (el: Record<string, unknown>) => this.created.push({ ...el, groupIds });
    const fillRect = (b: BBox, bg: string, opacity = 100) =>
      push(this.base("rectangle", b, "transparent", { backgroundColor: bg, fillStyle: "solid", roughness: 0, strokeWidth: 1, opacity, roundness: null }));
    // Backgrounds first, so lines and text sit on top.
    if ((opts.header ?? rows.length > 1) && rows.length > 1) fillRect({ x: x0, y: y0, w: W, h: rowH[0] }, "#f1f3f5");
    for (const hl of opts.highlight ?? []) {
      if (hl.row < 0 || hl.row >= rows.length || hl.col < 0 || hl.col >= cols) continue;
      fillRect({ x: colX[hl.col], y: rowY[hl.row], w: colW[hl.col], h: rowH[hl.row] }, hl.color ?? "#d3f9d8", 85);
    }
    push(this.base("rectangle", { x: x0, y: y0, w: W, h: H }, color, { strokeWidth: 1.5, roundness: null }));
    for (let j = 1; j < rows.length; j++) push(this.segment({ x: x0, y: rowY[j] }, { x: x0 + W, y: rowY[j] }, color, j === 1 && (opts.header ?? true) ? 1.5 : 1));
    for (let i = 1; i < cols; i++) push(this.segment({ x: colX[i], y: y0 }, { x: colX[i], y: y0 + H }, color, 1));
    for (let j = 0; j < rows.length; j++)
      for (let i = 0; i < cols; i++) {
        const t = cells[j][i];
        if (!t) continue;
        const m = measure(t, FS);
        push(this.text(t, { x: colX[i] + 12, y: rowY[j] + (rowH[j] - m.h) / 2, ...m }, color, null, FS));
      }
    if (title) push(this.text(title, { x: x0, y: box.y, ...tm }, color, null, 20));
    this.claim(box);
  }

  /** A straight hand-drawn line (not an arrow). */
  private segment(p: P, q: P, color: string, width = 1) {
    return this.base("line", { x: p.x, y: p.y, w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) }, color, {
      points: [
        [0, 0],
        [q.x - p.x, q.y - p.y],
      ],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: null,
      strokeWidth: width,
    });
  }

  // ------------------------------------------------------------- images

  /**
   * An image (screenshot, photo, render) in free space near the anchor, scaled
   * to `width` (default: natural size, at most 480 wide or 400 tall), with an
   * optional caption grouped with it so they move together.
   */
  image(fileId: string, natural: { width: number; height: number }, opts: { anchor?: BBox; at?: { x: number; y: number }; width?: number; caption?: string }) {
    checkWords(opts.caption);
    const k = opts.width ? opts.width / natural.width : Math.min(1, 480 / natural.width, 400 / natural.height);
    const w = Math.max(24, Math.round(natural.width * k));
    const h = Math.max(24, Math.round(natural.height * k));
    const caption = opts.caption ? wrap(opts.caption, 32) : "";
    const cm = caption ? measure(caption, NOTE_FONT) : { w: 0, h: 0 };
    const box = this.place(Math.max(w, cm.w), h + (caption ? cm.h + 10 : 0), opts.anchor, opts.at);
    const groupIds = caption ? [uid("g_")] : [];
    const img = this.base("image", { x: box.x + (box.w - w) / 2, y: box.y, w, h }, "transparent", {
      fileId,
      status: "saved",
      scale: [1, 1],
      crop: null,
      strokeWidth: 1,
      roundness: null,
      groupIds,
    });
    this.created.push(img);
    if (caption) {
      const text = this.text(caption, { x: box.x + (box.w - cm.w) / 2, y: box.y + h + 10, ...cm }, this.style.color ?? "#495057", null, NOTE_FONT);
      this.created.push({ ...text, groupIds });
    }
    this.claim(box);
    return img.id;
  }

  // ------------------------------------------------------------- charts

  /** A tiny bar chart: the visual answer to "how much / how many". */
  chart(data: { label: string; value: number }[], opts: { anchor?: BBox; title?: string }) {
    if (!data.length || data.length > 8) throw new Error("Il grafico vuole da 1 a 8 valori.");
    checkWords(opts.title, 8);
    const c = this.color;
    const W = Math.max(200, data.length * 56);
    const H = 130;
    const titleH = opts.title ? 30 : 0;
    const box = this.place(W, H + titleH + 40, opts.anchor);
    const max = Math.max(...data.map((d) => d.value), 1);
    const barW = (W - (data.length + 1) * 12) / data.length;
    if (opts.title) {
      const m = measure(opts.title, 18);
      this.created.push(this.text(opts.title, { x: box.x, y: box.y, ...m }, c, null, 18));
    }
    const baseY = box.y + titleH + H;
    this.created.push(
      this.stroke(
        [
          [box.x, baseY],
          [box.x + W, baseY],
        ],
        c,
        1,
      ),
    );
    data.forEach((d, i) => {
      const bh = Math.max(4, (d.value / max) * (H - 24));
      const x = box.x + 12 + i * (barW + 12);
      this.created.push(
        this.base("rectangle", { x, y: baseY - bh, w: barW, h: bh }, c, {
          backgroundColor: c,
          fillStyle: "hachure",
          roughness: 1,
          strokeWidth: 1,
        }),
      );
      const v = String(Math.round(d.value * 100) / 100);
      const vm = measure(v, 14);
      this.created.push(this.text(v, { x: x + (barW - vm.w) / 2, y: baseY - bh - vm.h - 2, ...vm }, c, null, 14));
      const l = wrap(d.label, 10);
      const lm = measure(l, 13);
      this.created.push(this.text(l, { x: x + (barW - lm.w) / 2, y: baseY + 6, ...lm }, c, null, 13));
    });
    this.claim(box);
  }

  // ------------------------------------------------------------- extend

  /**
   * Continue a structure someone drew: children in the person's ink and size,
   * linked by arrows. Several arrangements are tried (fan out in the drawing's
   * direction, a comb for long lists, the other sides) at growing distances,
   * and the first where no child and no arrow touches anything wins.
   */
  extend(
    anchor: BBox,
    children: { label: string; relation?: string }[],
    dir: Direction,
    opts: { color: string; fontSize: number; boxes: boolean },
  ) {
    if (!children.length || children.length > 8) throw new Error("Da 1 a 8 figli per volta.");
    for (const ch of children) checkWords(ch.label, 6);
    const sizes = children.map((ch) => {
      const t = wrap(ch.label, 18);
      const m = measure(t, opts.fontSize);
      return { t, w: opts.boxes ? m.w + 40 : m.w, h: opts.boxes ? m.h + 24 : m.h, m };
    });
    const n = sizes.length;
    const gap = 28;
    const ac = center(anchor);
    type Layout = { boxes: BBox[]; paths: P[][]; elbow: boolean };

    const fan = (side: Direction, dist: number): Layout => {
      const vertical = side === "down" || side === "up";
      const along = (s: { w: number; h: number }) => (vertical ? s.w : s.h);
      const total = sizes.reduce((acc, s) => acc + along(s), 0) + gap * (n - 1);
      let cursor = (vertical ? ac.x : ac.y) - total / 2;
      const boxes = sizes.map((s) => {
        const box =
          side === "right"
            ? { x: anchor.x + anchor.w + dist, y: cursor, w: s.w, h: s.h }
            : side === "left"
              ? { x: anchor.x - dist - s.w, y: cursor, w: s.w, h: s.h }
              : side === "down"
                ? { x: cursor, y: anchor.y + anchor.h + dist, w: s.w, h: s.h }
                : { x: cursor, y: anchor.y - dist - s.h, w: s.w, h: s.h };
        cursor += along(s) + gap;
        return box;
      });
      const start =
        side === "right"
          ? { x: anchor.x + anchor.w + 8, y: ac.y }
          : side === "left"
            ? { x: anchor.x - 8, y: ac.y }
            : side === "down"
              ? { x: ac.x, y: anchor.y + anchor.h + 8 }
              : { x: ac.x, y: anchor.y - 8 };
      const paths = boxes.map((b) => {
        const end =
          side === "right"
            ? { x: b.x - 8, y: b.y + b.h / 2 }
            : side === "left"
              ? { x: b.x + b.w + 8, y: b.y + b.h / 2 }
              : side === "down"
                ? { x: b.x + b.w / 2, y: b.y - 8 }
                : { x: b.x + b.w / 2, y: b.y + b.h + 8 };
        return [start, end];
      });
      return { boxes, paths, elbow: false };
    };

    // A comb: a spine going down from the node, one short elbow per child. Long lists never cross.
    const comb = (dist: number): Layout => {
      const spineX = anchor.x + Math.min(28, anchor.w / 3);
      let y = anchor.y + anchor.h + dist;
      const boxes = sizes.map((s) => {
        const box = { x: spineX + 34, y, w: s.w, h: s.h };
        y += s.h + 14;
        return box;
      });
      const top = { x: spineX, y: anchor.y + anchor.h + 6 };
      const paths = boxes.map((b) => [top, { x: spineX, y: b.y + b.h / 2 }, { x: b.x - 6, y: b.y + b.h / 2 }]);
      return { boxes, paths, elbow: true };
    };

    const order: ((dist: number) => Layout)[] = [];
    const fanSide = (side: Direction) => (dist: number) => fan(side, dist);
    if (dir === "down") {
      if (n > 3) order.push(comb, fanSide("right"), fanSide("down"));
      else order.push(fanSide("down"), comb, fanSide("right"));
    } else if (dir === "right") order.push(fanSide("right"), comb, fanSide("down"));
    else if (dir === "left") order.push(fanSide("left"), comb, fanSide("down"));
    else order.push(fanSide("up"), fanSide("right"), comb);
    order.push(fanSide("left"), fanSide("up"));

    // Score every arrangement at every distance and keep the best: children on top of something
    // are the worst, then arrows over text, then crossings with other arrows; closer and earlier
    // (= the direction the drawing already goes) win ties. Arrows stay straight or elbowed:
    // predictable shapes read better than curves dodging around.
    const score = (l: Layout, k: number, rank: number) => {
      let s = l.boxes.filter((b) => this.overlaps(b, 30)).length * 10;
      l.paths.forEach((path, i) => {
        s += this.pathHits(path, [anchor, l.boxes[i]], l.boxes.filter((_, j) => j !== i)) * 4;
        s += this.crossings(path) * 2;
      });
      return s + k * 0.25 + rank * 0.6;
    };
    let best: { l: Layout; s: number } | undefined;
    order.forEach((make, rank) => {
      for (let k = 0; k < 10; k++) {
        const l = make(60 + k * 40);
        const sc = score(l, k, rank);
        if (!best || sc < best.s) best = { l, s: sc };
      }
    });
    const chosen = best!.l;

    const labelled = !chosen.elbow && n <= 3;
    chosen.boxes.forEach((b, i) => {
      const s = sizes[i];
      if (opts.boxes) {
        const shape = this.base("rectangle", b, opts.color, { roughness: 1.5 });
        const t = this.text(s.t, { x: b.x + (b.w - s.m.w) / 2, y: b.y + (b.h - s.m.h) / 2, ...s.m }, opts.color, shape.id, opts.fontSize);
        (shape as Record<string, unknown>).boundElements = [{ type: "text", id: t.id }];
        this.created.push(shape, t);
      } else {
        this.created.push(this.text(s.t, b, opts.color, null, opts.fontSize));
      }
      this.claim(b);
    });
    chosen.paths.forEach((path, i) =>
      this.arrowAlong(
        path,
        false,
        opts.color,
        labelled && path.length === 2 ? children[i].relation : undefined,
        { roughness: 1, strokeWidth: 1.5 },
        chosen.boxes,
      ),
    );
  }
}

const FILL_STYLES = new Set(["solid", "hachure", "cross-hatch", "zigzag"]);

/** Bounds of a scene without a viewBox (text estimated). */
function sceneBounds(items: SceneItem[]): BBox {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const it of items) {
    if (it.kind === "rect") xs.push(it.x, it.x + it.w), ys.push(it.y, it.y + it.h);
    else if (it.kind === "ellipse") xs.push(it.cx - it.rx, it.cx + it.rx), ys.push(it.cy - it.ry, it.cy + it.ry);
    else if (it.kind === "line") for (const [x, y] of it.points) xs.push(x), ys.push(y);
    else {
      const size = it.paint.fontSize ?? 16;
      const m = measure(it.text, size);
      const left = it.paint.anchor === "middle" ? it.x - m.w / 2 : it.paint.anchor === "end" ? it.x - m.w : it.x;
      xs.push(left, left + m.w);
      ys.push(it.y - size, it.y - size + m.h);
    }
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
}

function unionOf(a: BBox, b: BBox): BBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Segment between the borders of two boxes, along the line joining their centers. */
function connect(a: BBox, b: BBox): [{ x: number; y: number }, { x: number; y: number }] {
  const ca = center(a);
  const cb = center(b);
  return [exitPoint(a, ca, cb, 8), exitPoint(b, cb, ca, 8)];
}

function exitPoint(box: BBox, from: { x: number; y: number }, toward: { x: number; y: number }, gap: number) {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const tx = dx !== 0 ? box.w / 2 / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? box.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: from.x + dx * t + (dx / len) * gap, y: from.y + dy * t + (dy / len) * gap };
}
