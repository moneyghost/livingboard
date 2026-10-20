import { type BBox, type Candidate, type CandidateKind, isAiAuthored } from "@livingboard/shared";

/** The subset of an Excalidraw element the server cares about. */
export interface El {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  version: number;
  groupIds?: string[];
  frameId?: string | null;
  containerId?: string | null;
  text?: string;
  originalText?: string;
  name?: string | null;
  points?: [number, number][];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  customData?: Record<string, unknown>;
  index?: string | null;
  strokeColor?: string;
  /** Last edit time (ms), set by Excalidraw. */
  updated?: number;
}

const SHAPES = new Set(["rectangle", "ellipse", "diamond", "embeddable", "iframe"]);
const STROKES = new Set(["freedraw", "line"]);
const FRAMES = new Set(["frame", "magicframe"]);

const SHAPE_NAMES: Record<string, string> = {
  rectangle: "rettangolo",
  ellipse: "ellisse",
  diamond: "rombo",
  embeddable: "embed",
  iframe: "iframe",
};

/** Max distance (scene px) between strokes that belong to the same sketch. */
const STROKE_GAP = 30;
/** Max distance between a free text and the stroke cluster it labels. */
const LABEL_GAP = 30;
/** Max distance between a free text and a shape it captions. */
const CAPTION_GAP = 16;
/** How far from a cluster an unbound arrow end may land and still connect. */
const ARROW_SNAP = 40;
/** Max distance between a free text's center and an arrow's middle for it to be the arrow's label. */
const ARROW_LABEL_GAP = 40;

// Freehand ink. Handwriting is clustered with a gap proportional to its size, and
// long sparse strokes ("wires": hand-drawn arrows, underlines, brackets) are kept
// out of that clustering: they either connect two clusters (a link) or decorate one.
/** A stroke whose ends are at least this far apart and that is fairly straight is a wire. */
const WIRE_MIN_SPAN = 32;
const WIRE_STRAIGHT = 2.2;
/** ...or a long stroke that wanders but stays sparse (a curly arrow, not a cursive word). */
const WIRE_LONG = 150;
const WIRE_CURL = 2.6;
/** Words on one line sit further apart than lines of a note: two thresholds, both relative to the smaller stroke. */
const INK_LINE_FACTOR = 1.8;
const INK_LINE_MIN = 12;
const INK_LINE_MAX = 56;
const INK_GAP_FACTOR = 1;
const INK_GAP_MIN = 8;
const INK_GAP_MAX = 36;
/** Different ink colors usually mean different thoughts: be stricter. */
const INK_COLOR_FACTOR = 0.7;
/** Small strokes at a wire's tip are its arrowhead. */
const ARROWHEAD_SIZE = 30;
const ARROWHEAD_REACH = 12;
/** Stray dots and specks join the nearest cluster. */
const SPECK = 20;

const QUESTION_RE = /^\s*@(ai|claude|livingboard)\b/i;

export function elementBBox(el: El): BBox {
  if (el.points && el.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of el.points) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    return { x: el.x + minX, y: el.y + minY, w: maxX - minX, h: maxY - minY };
  }
  return { x: el.x, y: el.y, w: el.width, h: el.height };
}

export function unionBBox(boxes: BBox[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Distance between two boxes (0 when they overlap). */
export function boxGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
}

export function contains(outer: BBox, inner: BBox, tolerance = 2): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}

/** Middle of an arrow's polyline (the vertex in the middle, or the midpoint of a 2-point arrow). */
function arrowMid(a: El): { x: number; y: number } {
  const pts = a.points?.length ? a.points : [[0, 0] as [number, number], [a.width, a.height] as [number, number]];
  if (pts.length % 2 === 1) {
    const [x, y] = pts[(pts.length - 1) / 2];
    return { x: a.x + x, y: a.y + y };
  }
  const [x1, y1] = pts[pts.length / 2 - 1];
  const [x2, y2] = pts[pts.length / 2];
  return { x: a.x + (x1 + x2) / 2, y: a.y + (y1 + y2) / 2 };
}

function pointDistance(b: BBox, px: number, py: number): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h));
  return Math.hypot(dx, dy);
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const area = (b: BBox) => Math.max(1, b.w) * Math.max(1, b.h);
const textOf = (el: El) => (el.originalText ?? el.text ?? "").trim();
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Union-find with "cannot-link" tags: two clusters carrying different tags
 * (explicit groups made by a human or the agent, or Excalidraw groups) never merge.
 */
class UnionFind {
  private parent = new Map<string, string>();
  private tag = new Map<string, string>();
  add(id: string, tag?: string) {
    if (this.parent.has(id)) return;
    this.parent.set(id, id);
    if (tag) this.tag.set(id, tag);
  }
  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return true;
    const ta = this.tag.get(ra);
    const tb = this.tag.get(rb);
    if (ta && tb && ta !== tb) return false;
    this.parent.set(rb, ra);
    if (!ta && tb) this.tag.set(ra, tb);
    return true;
  }
  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const r = this.find(id);
      const list = out.get(r);
      if (list) list.push(id);
      else out.set(r, [id]);
    }
    return out;
  }
}

interface Draft {
  kind: CandidateKind;
  elementIds: string[];
  anchor: string;
  bbox: BBox;
  texts: string[];
  summary: string;
  needsVision: boolean;
  fromRoot?: string;
  toRoot?: string;
  root?: string;
}

type Pt = { x: number; y: number };

interface Ink {
  size: number;
  len: number;
  span: number;
  diag: number;
  color: string;
  start: Pt;
  end: Pt;
  mid: Pt;
}

function inkOf(el: El, box: BBox): Ink {
  const pts = el.points?.length ? el.points : [[0, 0] as [number, number], [el.width, el.height] as [number, number]];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const start = { x: el.x + pts[0][0], y: el.y + pts[0][1] };
  const end = { x: el.x + pts[pts.length - 1][0], y: el.y + pts[pts.length - 1][1] };
  return {
    size: Math.max(box.w, box.h),
    len,
    span: Math.hypot(end.x - start.x, end.y - start.y),
    diag: Math.hypot(box.w, box.h),
    color: el.strokeColor ?? "",
    start,
    end,
    mid: arrowMid(el),
  };
}

// Closed or coiled strokes (a circle, a blade outline) never qualify: a wire goes somewhere.
const looksLikeWire = (k: Ink) =>
  (k.span >= WIRE_MIN_SPAN && k.len <= WIRE_STRAIGHT * k.span) ||
  (k.len >= WIRE_LONG && k.len <= WIRE_CURL * k.diag && k.span >= 0.5 * k.diag);

/**
 * How far two strokes may be and still be one thought. Sized on the smaller
 * stroke (a heading next to a footnote is not one phrase), wider along a line of
 * writing than between lines, stricter across ink colors.
 */
function inkGap(a: Ink, b: Ink, ba: BBox, bb: BBox): number {
  const s = Math.min(a.size, b.size, 60);
  const overlap = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
  const sameLine = overlap >= 0.5 * Math.min(ba.h, bb.h);
  const t = sameLine
    ? Math.min(INK_LINE_MAX, Math.max(INK_LINE_MIN, INK_LINE_FACTOR * s))
    : Math.min(INK_GAP_MAX, Math.max(INK_GAP_MIN, INK_GAP_FACTOR * s));
  return a.color && b.color && a.color !== b.color ? t * INK_COLOR_FACTOR : t;
}

/**
 * A wire that runs along two clusters instead of pointing from one to the other
 * (an underline under two words, a bracket beside two lines) says they are one.
 */
function runsAlong(wire: BBox, a: BBox, b: BBox): boolean {
  const horizontal = wire.h <= 0.35 * wire.w;
  const vertical = wire.w <= 0.35 * wire.h;
  const xOverlap = (c: BBox) => Math.min(c.x + c.w, wire.x + wire.w) - Math.max(c.x, wire.x) >= 0.5 * c.w;
  const yOverlap = (c: BBox) => Math.min(c.y + c.h, wire.y + wire.h) - Math.max(c.y, wire.y) >= 0.5 * c.h;
  if (horizontal && xOverlap(a) && xOverlap(b)) {
    const below = (c: BBox) => c.y + c.h <= wire.y + wire.h / 2 + 15;
    const above = (c: BBox) => c.y >= wire.y + wire.h / 2 - 15;
    return (below(a) && below(b)) || (above(a) && above(b));
  }
  if (vertical && yOverlap(a) && yOverlap(b)) {
    const right = (c: BBox) => c.x + c.w <= wire.x + wire.w / 2 + 15;
    const left = (c: BBox) => c.x >= wire.x + wire.w / 2 - 15;
    return (right(a) && right(b)) || (left(a) && left(b));
  }
  return false;
}

/**
 * Geometric pre-pass: groups raw Excalidraw elements into candidates — clusters
 * that probably express one idea — and arrows into links between them. It never
 * guesses meaning; that is the agent's job. It only makes the board cheap to read.
 */
export function segment(
  all: El[],
  prev: Map<string, Candidate>,
  now: number,
  /** elementId -> explicit group id (made by a human or the agent). */
  explicit: Map<string, string> = new Map(),
): Candidate[] {
  const live = all.filter((e) => !e.isDeleted && !isAiAuthored(e));
  const byId = new Map(live.map((e) => [e.id, e]));
  const boxes = new Map(live.map((e) => [e.id, elementBBox(e)]));

  // Bound text belongs to its container; arrow labels belong to the arrow.
  const boundTexts = new Map<string, El[]>();
  const units: El[] = [];
  for (const el of live) {
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) {
      const list = boundTexts.get(el.containerId) ?? [];
      list.push(el);
      boundTexts.set(el.containerId, list);
      continue;
    }
    units.push(el);
  }

  const frames = units.filter((e) => FRAMES.has(e.type));
  const arrows = units.filter((e) => e.type === "arrow");

  // People often write an arrow's label as free text next to it: claim those first,
  // otherwise a nearby shape swallows the label and the arrow loses an endpoint.
  const shapeBoxes = units.filter((e) => SHAPES.has(e.type)).map((e) => boxes.get(e.id)!);
  const freeLabels = new Map<string, El[]>();
  const claimedTexts = new Set<string>();
  for (const t of units) {
    if (t.type !== "text") continue;
    const tb = boxes.get(t.id)!;
    if (shapeBoxes.some((b) => contains(b, tb))) continue;
    const cx = tb.x + tb.w / 2;
    const cy = tb.y + tb.h / 2;
    let best: { arrow: El; d: number } | undefined;
    for (const a of arrows) {
      const m = arrowMid(a);
      const d = Math.max(0, Math.hypot(cx - m.x, cy - m.y) - Math.max(tb.w, tb.h) / 2);
      if (d <= ARROW_LABEL_GAP && (!best || d < best.d)) best = { arrow: a, d };
    }
    if (!best) continue;
    const list = freeLabels.get(best.arrow.id) ?? [];
    list.push(t);
    freeLabels.set(best.arrow.id, list);
    claimedTexts.add(t.id);
  }

  const rest = units.filter((e) => !FRAMES.has(e.type) && e.type !== "arrow" && !claimedTexts.has(e.id));

  // Explicit groups win over Excalidraw groups; both force elements together and keep groups apart.
  const tagOf = (el: El) => {
    const g = explicit.get(el.id);
    if (g) return `g:${g}`;
    const ex = el.groupIds?.length ? el.groupIds[el.groupIds.length - 1] : undefined;
    return ex ? `x:${ex}` : undefined;
  };
  const uf = new UnionFind();
  for (const el of rest) uf.add(el.id, tagOf(el));
  const tagFirst = new Map<string, string>();
  for (const el of rest) {
    const t = tagOf(el);
    if (!t) continue;
    const first = tagFirst.get(t);
    if (first) uf.union(first, el.id);
    else tagFirst.set(t, el.id);
  }

  const shapes = rest.filter((e) => SHAPES.has(e.type));
  // A shape holding other shapes is a zone, not a node: don't swallow its contents.
  const zones = new Set(
    shapes
      .filter((s) => shapes.some((o) => o !== s && contains(boxes.get(s.id)!, boxes.get(o.id)!)))
      .map((s) => s.id),
  );

  const freeTexts = rest.filter((e) => e.type === "text");
  const strokes = rest.filter((e) => STROKES.has(e.type));
  const inks = new Map(strokes.map((e) => [e.id, inkOf(e, boxes.get(e.id)!)]));
  // A grouped stroke is content by decision: never a wire.
  const wireIds = new Set(strokes.filter((e) => !tagOf(e) && looksLikeWire(inks.get(e.id)!)).map((e) => e.id));
  const ink = strokes.filter((e) => !wireIds.has(e.id));

  // Text or strokes inside a (non-zone) shape annotate that shape.
  for (const el of [...freeTexts, ...ink]) {
    const b = boxes.get(el.id)!;
    let best: El | undefined;
    for (const s of shapes) {
      if (zones.has(s.id)) continue;
      if (contains(boxes.get(s.id)!, b) && (!best || area(boxes.get(s.id)!) < area(boxes.get(best.id)!))) best = s;
    }
    if (best) uf.union(best.id, el.id);
  }

  // Handwriting: strokes closer than (a fraction of) their own size form one cluster.
  for (let i = 0; i < ink.length; i++) {
    const a = inks.get(ink[i].id)!;
    const ba = boxes.get(ink[i].id)!;
    for (let j = i + 1; j < ink.length; j++) {
      const b = inks.get(ink[j].id)!;
      const bb = boxes.get(ink[j].id)!;
      if (boxGap(ba, bb) <= inkGap(a, b, ba, bb)) uf.union(ink[i].id, ink[j].id);
    }
  }

  const clusterBox = () => {
    const out = new Map<string, BBox>();
    for (const [root, ids] of uf.groups()) out.set(root, unionBBox(ids.map((id) => boxes.get(id)!)));
    return out;
  };
  /** Wires already merged into a cluster as decoration (underline, bracket, stray line). */
  const decorated = new Set<string>();
  /** Clusters with real content (not a lone unresolved wire). */
  const contentBoxes = () => {
    const out = new Map<string, BBox>();
    for (const [root, ids] of uf.groups()) {
      if (ids.every((id) => wireIds.has(id) && !decorated.has(id))) continue;
      out.set(root, unionBBox(ids.map((id) => boxes.get(id)!)));
    }
    return out;
  };
  /** A few tiny strokes: could be an arrowhead, so a poor target for a wire. */
  const headLike = (ids: string[]) =>
    ids.length <= 3 && ids.every((id) => !wireIds.has(id) && STROKES.has(byId.get(id)!.type) && inks.get(id)!.size <= ARROWHEAD_SIZE);
  const nearestCluster = (cb: Map<string, BBox>, p: Pt): string | undefined => {
    const groups = uf.groups();
    let best: { root: string; d: number; head: boolean } | undefined;
    for (const [r, b] of cb) {
      const d = pointDistance(b, p.x, p.y);
      if (d > ARROW_SNAP) continue;
      const head = headLike(groups.get(r) ?? []);
      const better =
        !best ||
        (best.head && !head) ||
        (best.head === head && (d < best.d || (d === best.d && area(b) < area(cb.get(best.root)!))));
      if (better) best = { root: r, d, head };
    }
    return best?.root;
  };

  // A free text right next to a sketch or a shape is its label. Run again after
  // wires decorate clusters (a sword's crossguard widens the sketch it labels).
  const attachLabels = () => {
    const cb = clusterBox();
    const groups = uf.groups();
    for (const t of freeTexts) {
      const root = uf.find(t.id);
      if ((groups.get(root)?.length ?? 1) > 1) continue; // already attached
      const tb = boxes.get(t.id)!;
      let best: { root: string; gap: number } | undefined;
      for (const [r, b] of cb) {
        if (r === root) continue;
        const members = groups.get(r) ?? [];
        if (members.length === 1 && byId.get(members[0])!.type === "text") continue; // text never labels text
        if (members.every((id) => wireIds.has(id))) continue;
        const hasStroke = members.some((id) => STROKES.has(byId.get(id)!.type));
        const hasShape = members.some((id) => SHAPES.has(byId.get(id)!.type) && !zones.has(id));
        const limit = hasStroke ? LABEL_GAP : hasShape ? CAPTION_GAP : -1;
        const gap = boxGap(tb, b);
        if (gap <= limit && (!best || gap < best.gap)) best = { root: r, gap };
      }
      if (best) uf.union(best.root, t.id);
    }
  };
  attachLabels();

  // Wires: two different clusters at the ends -> link; one cluster -> decoration
  // (underline, bracket). Resolved in passes because decorations grow clusters.
  type WireLink = { wire: El; from: string; to: string };
  const wireLinks: WireLink[] = [];
  let pending = strokes.filter((e) => wireIds.has(e.id));
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    const cb = contentBoxes();
    const next: El[] = [];
    for (const w of pending) {
      const k = inks.get(w.id)!;
      const a = nearestCluster(cb, k.start);
      const b = nearestCluster(cb, k.end);
      if (a && b && a !== b && runsAlong(boxes.get(w.id)!, cb.get(a)!, cb.get(b)!)) {
        uf.union(a, b);
        uf.union(a, w.id);
        decorated.add(w.id);
      } else if (a && b && a !== b) wireLinks.push({ wire: w, from: a, to: b });
      else if (a && b) {
        uf.union(a, w.id);
        decorated.add(w.id);
      } else if (pass === 2 && (a || b)) {
        uf.union((a ?? b)!, w.id);
        decorated.add(w.id);
      } else next.push(w);
    }
    pending = next;
  }
  // Wires touching nothing are just lines someone drew.
  for (const w of pending) decorated.add(w.id);
  attachLabels();
  const wireLinkIds = new Set(wireLinks.map((l) => l.wire.id));

  // Arrowheads (small strokes at a wire's tip) and typed labels at its middle belong to the link.
  const absorbed = new Map<string, string>(); // cluster root -> wire id
  const linkExtras = new Map<string, string[]>();
  {
    const groups = uf.groups();
    const endpoints = new Set(wireLinks.flatMap((l) => [uf.find(l.from), uf.find(l.to)]));
    for (const [root, ids] of groups) {
      if (endpoints.has(root)) continue;
      if (ids.length > 3 || !ids.every((id) => STROKES.has(byId.get(id)!.type) && !wireIds.has(id))) continue;
      if (!ids.every((id) => inks.get(id)!.size <= ARROWHEAD_SIZE)) continue;
      const box = unionBBox(ids.map((id) => boxes.get(id)!));
      const hit = wireLinks.find((l) => {
        const k = inks.get(l.wire.id)!;
        return pointDistance(box, k.end.x, k.end.y) <= ARROWHEAD_REACH || pointDistance(box, k.start.x, k.start.y) <= ARROWHEAD_REACH;
      });
      if (hit) absorbed.set(root, hit.wire.id);
    }
    for (const [root, ids] of groups) {
      if (absorbed.has(root) || endpoints.has(root) || ids.length !== 1 || byId.get(ids[0])!.type !== "text") continue;
      const tb = boxes.get(ids[0])!;
      const hit = wireLinks.find((l) => {
        const m = inks.get(l.wire.id)!.mid;
        return Math.max(0, Math.hypot(tb.x + tb.w / 2 - m.x, tb.y + tb.h / 2 - m.y) - Math.max(tb.w, tb.h) / 2) <= ARROW_LABEL_GAP;
      });
      if (hit) absorbed.set(root, hit.wire.id);
    }
    for (const [root, wire] of absorbed) linkExtras.set(wire, [...(linkExtras.get(wire) ?? []), ...(groups.get(root) ?? [])]);
  }

  // Specks (a dot, a short dash) join the nearest cluster instead of becoming nodes.
  {
    const groups = uf.groups();
    const cb = contentBoxes();
    for (const [root, ids] of groups) {
      if (absorbed.has(root) || !ids.every((id) => STROKES.has(byId.get(id)!.type) && !wireLinkIds.has(id))) continue;
      const box = cb.get(root);
      if (!box || Math.hypot(box.w, box.h) > SPECK) continue;
      let best: { root: string; gap: number } | undefined;
      for (const [r, b] of cb) {
        if (r === root || absorbed.has(r)) continue;
        if ((groups.get(r) ?? []).every((id) => wireLinkIds.has(id))) continue;
        const gap = boxGap(box, b);
        if (gap <= ARROW_SNAP && (!best || gap < best.gap)) best = { root: r, gap };
      }
      if (best) uf.union(best.root, root);
    }
  }

  // Arrows: links between clusters when both ends resolve, otherwise just strokes.
  const cb = clusterBox();
  const resolveEnd = (binding: { elementId: string } | null | undefined, px: number, py: number): string | undefined => {
    if (binding && byId.has(binding.elementId)) {
      const target = byId.get(binding.elementId)!;
      if (FRAMES.has(target.type)) return undefined;
      const id = target.type === "text" && target.containerId ? target.containerId : target.id;
      if (byId.has(id) && !FRAMES.has(byId.get(id)!.type) && byId.get(id)!.type !== "arrow") return uf.find(id);
    }
    let best: { root: string; d: number } | undefined;
    for (const [r, b] of cb) {
      if (absorbed.has(r)) continue;
      const d = pointDistance(b, px, py);
      if (d <= ARROW_SNAP && (!best || d < best.d || (d === best.d && area(b) < area(cb.get(best.root)!)))) best = { root: r, d };
    }
    return best?.root;
  };

  const links: Draft[] = [];
  for (const a of arrows) {
    const pts = a.points ?? [
      [0, 0],
      [a.width, a.height],
    ];
    const [sx, sy] = pts[0];
    const [ex, ey] = pts[pts.length - 1];
    const fromRoot = resolveEnd(a.startBinding, a.x + sx, a.y + sy);
    const toRoot = resolveEnd(a.endBinding, a.x + ex, a.y + ey);
    if (fromRoot && toRoot && fromRoot !== toRoot) {
      const labels = [...(boundTexts.get(a.id) ?? []), ...(freeLabels.get(a.id) ?? [])];
      const label = labels.map(textOf).filter(Boolean).join(" ");
      links.push({
        kind: "link",
        elementIds: [a.id, ...labels.map((l) => l.id)],
        anchor: a.id,
        bbox: boxes.get(a.id)!,
        texts: label ? [label] : [],
        summary: label ? `freccia «${clip(label, 60)}»` : "freccia",
        needsVision: false,
        fromRoot,
        toRoot,
      });
    } else if (fromRoot && fromRoot === toRoot) {
      // Both ends inside one idea (e.g. after grouping): the arrow is part of it.
      uf.add(a.id);
      uf.union(fromRoot, a.id);
      for (const t of freeLabels.get(a.id) ?? []) {
        uf.add(t.id);
        uf.union(a.id, t.id);
      }
    } else {
      uf.add(a.id);
      for (const s of ink) if (boxGap(boxes.get(a.id)!, boxes.get(s.id)!) <= STROKE_GAP) uf.union(s.id, a.id);
      for (const t of freeLabels.get(a.id) ?? []) {
        uf.add(t.id);
        uf.union(a.id, t.id);
      }
    }
  }

  // Hand-drawn links. If both ends ended up in one cluster, the wire just decorates it.
  for (const l of wireLinks) {
    const from = uf.find(l.from);
    const to = uf.find(l.to);
    if (from === to) {
      uf.union(from, l.wire.id);
      wireLinkIds.delete(l.wire.id);
      continue;
    }
    const extras = (linkExtras.get(l.wire.id) ?? []).filter((id) => id !== l.wire.id);
    const labels = extras.map((id) => byId.get(id)!).filter((e) => e.type === "text");
    const label = labels.map(textOf).filter(Boolean).join(" ");
    const ids = [l.wire.id, ...extras];
    links.push({
      kind: "link",
      elementIds: ids,
      anchor: l.wire.id,
      bbox: unionBBox(ids.map((id) => boxes.get(id)!)),
      texts: label ? [label] : [],
      summary: label ? `freccia disegnata «${clip(label, 60)}»` : "freccia disegnata",
      needsVision: false,
      fromRoot: from,
      toRoot: to,
    });
  }

  // Build cluster drafts.
  const drafts: Draft[] = [];
  for (const [root, ids] of uf.groups()) {
    if (absorbed.has(root)) continue;
    if (ids.length === 1 && wireLinkIds.has(ids[0])) continue;
    const els = ids.map((id) => byId.get(id)!);
    const allIds = [...ids];
    const textEls: El[] = [];
    for (const el of els) {
      if (el.type === "text") textEls.push(el);
      for (const bt of boundTexts.get(el.id) ?? []) {
        textEls.push(bt);
        allIds.push(bt.id);
      }
    }
    textEls.sort((p, q) => p.y - q.y || p.x - q.x);
    const texts = textEls.map(textOf).filter(Boolean);
    const shapeEls = els.filter((e) => SHAPES.has(e.type));
    const strokeCount = els.filter((e) => STROKES.has(e.type) || e.type === "arrow").length;
    const hasImage = els.some((e) => e.type === "image");

    let kind: CandidateKind;
    if (shapeEls.length > 0) kind = "shape";
    else if (hasImage) kind = "image";
    else if (strokeCount > 0) kind = "sketch";
    else kind = texts.some((t) => QUESTION_RE.test(t)) ? "question" : "text";

    const quoted = texts.length ? ` «${clip(texts.join(" / "))}»` : "";
    let summary: string;
    if (kind === "shape") {
      const names = [...new Set(shapeEls.map((s) => SHAPE_NAMES[s.type] ?? s.type))].join(" + ");
      summary = `${names}${quoted}${strokeCount ? ` + schizzo (${strokeCount} tratti)` : ""}`;
    } else if (kind === "sketch") summary = `schizzo a mano libera (${strokeCount} tratti)${quoted}`;
    else if (kind === "image") summary = `immagine${quoted}`;
    else if (kind === "question") summary = `domanda${quoted}`;
    else summary = `testo${quoted}`;

    const anchor =
      [...shapeEls].sort((p, q) => area(boxes.get(q.id)!) - area(boxes.get(p.id)!))[0]?.id ?? [...ids].sort()[0];

    drafts.push({
      kind,
      elementIds: allIds,
      anchor,
      bbox: unionBBox(allIds.map((id) => boxes.get(id)!)),
      texts,
      summary,
      needsVision: strokeCount > 0 || hasImage,
      root,
    });
  }

  for (const f of frames) {
    const name = (f.name ?? "").trim();
    drafts.push({
      kind: "frame",
      elementIds: [f.id],
      anchor: f.id,
      bbox: boxes.get(f.id)!,
      texts: name ? [name] : [],
      summary: name ? `riquadro «${clip(name, 60)}»` : "riquadro",
      needsVision: false,
    });
  }

  // Stable ids: reuse the previous candidate that shares the most elements, but
  // only if it is still mostly the same thing (a split gives every part a new id).
  const claimed = new Set<string>();
  const assign = (d: Draft): string => {
    const isLink = d.kind === "link";
    let best: { id: string; overlap: number } | undefined;
    const mine = new Set(d.elementIds);
    for (const p of prev.values()) {
      if ((p.kind === "link") !== isLink || claimed.has(p.id)) continue;
      const overlap = p.elementIds.reduce((n, id) => n + (mine.has(id) ? 1 : 0), 0);
      if (overlap < 0.5 * Math.max(p.elementIds.length, d.elementIds.length)) continue;
      if (!best || overlap > best.overlap) best = { id: p.id, overlap };
    }
    let id = best?.id ?? `${isLink ? "l" : "c"}_${d.anchor}`;
    while (claimed.has(id)) id += "_";
    claimed.add(id);
    return id;
  };

  const out: Candidate[] = [];
  const rootToId = new Map<string, string>();
  const ordered = [...drafts].sort((p, q) => q.elementIds.length - p.elementIds.length);
  for (const d of ordered) {
    const id = assign(d);
    if (d.root) rootToId.set(d.root, id);
    out.push(toCandidate(id, d, byId, prev, now));
  }
  for (const d of links) {
    const from = rootToId.get(uf.find(d.fromRoot!));
    const to = rootToId.get(uf.find(d.toRoot!));
    if (!from || !to) continue;
    const id = assign(d);
    out.push(toCandidate(id, d, byId, prev, now, from, to));
  }

  // Parent = smallest shape/frame candidate that fully contains this one.
  const containers = out.filter((c) => c.kind === "frame" || c.kind === "shape");
  for (const c of out) {
    if (c.kind === "link") continue;
    let best: Candidate | undefined;
    for (const p of containers) {
      if (p.id === c.id || area(p.bbox) <= area(c.bbox)) continue;
      if (contains(p.bbox, c.bbox) && (!best || area(p.bbox) < area(best.bbox))) best = p;
    }
    if (best) c.parentId = best.id;
  }
  return out;
}

/** What an element says, ignoring where it is: moving things around is not a change of meaning. */
function contentSig(el: El | undefined): string {
  if (!el) return "-";
  const p = el.points;
  const pts = p?.length ? `${p.length}:${Math.round(p[p.length - 1][0])},${Math.round(p[p.length - 1][1])}` : "";
  const e = el as El & { backgroundColor?: string; fontSize?: number };
  return fnv(
    [el.type, el.text ?? "", Math.round(el.width), Math.round(el.height), pts, el.strokeColor ?? "", e.backgroundColor ?? "", e.fontSize ?? "", el.containerId ?? ""].join("|"),
  );
}

function toCandidate(
  id: string,
  d: Draft,
  byId: Map<string, El>,
  prev: Map<string, Candidate>,
  now: number,
  from?: string,
  to?: string,
): Candidate {
  const sig = [...d.elementIds]
    .sort()
    .map((eid) => `${eid}:${contentSig(byId.get(eid))}`)
    .join("|");
  const hash = fnv(`${sig}#${from ?? ""}>${to ?? ""}`);
  const old = prev.get(id);
  const round = (n: number) => Math.round(n);
  return {
    id,
    kind: d.kind,
    elementIds: d.elementIds,
    bbox: { x: round(d.bbox.x), y: round(d.bbox.y), w: round(d.bbox.w), h: round(d.bbox.h) },
    texts: d.texts,
    summary: d.summary,
    from,
    to,
    hash,
    changedAt: old && old.hash === hash ? old.changedAt : now,
    state: old?.state ?? "maturing",
    matureAt: old?.matureAt,
    needsVision: d.needsVision,
  };
}
