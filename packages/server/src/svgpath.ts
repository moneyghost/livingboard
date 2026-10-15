/**
 * SVG → a flat list of drawable items, so the agent can draw with the
 * language it knows best. Shapes stay shapes (rect, ellipse), paths and
 * polylines become lines (closed ones can be filled), <text> stays text,
 * markers become arrowheads. Group transforms and inherited paint are
 * resolved here; draw.ts only scales, places and styles.
 */

export type Pt = [number, number];

export interface Paint {
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  dash?: "dashed" | "dotted";
  opacity?: number;
  /** Excalidraw fill style, from data-fill: solid (default), hachure, cross-hatch, zigzag. */
  fillStyle?: string;
  fontSize?: number;
  anchor?: "start" | "middle" | "end";
  bold?: boolean;
}

export type SceneItem =
  | { kind: "rect"; x: number; y: number; w: number; h: number; rounded: boolean; paint: Paint }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; paint: Paint }
  | { kind: "line"; points: Pt[]; arrowStart: boolean; arrowEnd: boolean; paint: Paint }
  | { kind: "text"; x: number; y: number; text: string; paint: Paint };

export interface Scene {
  items: SceneItem[];
  viewBox?: { x: number; y: number; w: number; h: number };
}

const CURVE_STEPS = 12;

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, out: Pt[]) {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

function quad(p0: Pt, p1: Pt, p2: Pt, out: Pt[]) {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}

/** Elliptical arc (SVG endpoint parameterisation) sampled into points, per the SVG spec's conversion. */
function arc(p0: Pt, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p1: Pt, out: Pt[]) {
  if (rx === 0 || ry === 0) {
    out.push(p1);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t0 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((Math.abs(dt) / (Math.PI * 2)) * 32));
  for (let i = 1; i <= steps; i++) {
    const t = t0 + (dt * i) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

/** Parse a path `d` attribute into one polyline per subpath. */
export function parsePath(d: string): Pt[][] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const polylines: Pt[][] = [];
  let cur: Pt[] = [];
  let pos: Pt = [0, 0];
  let start: Pt = [0, 0];
  let lastCtrl: Pt | null = null;
  let lastCmd = "";
  let i = 0;
  const num = () => Number(tokens[i++]);
  const flush = () => {
    if (cur.length > 1) polylines.push(cur);
    cur = [];
  };

  while (i < tokens.length) {
    let cmd = tokens[i];
    if (/^[a-zA-Z]$/.test(cmd)) i++;
    else cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd; // implicit repeat
    if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const at = (x: number, y: number): Pt => (rel ? [pos[0] + x, pos[1] + y] : [x, y]);
    switch (cmd.toUpperCase()) {
      case "M": {
        flush();
        pos = at(num(), num());
        start = pos;
        cur = [pos];
        lastCtrl = null;
        break;
      }
      case "L":
        pos = at(num(), num());
        cur.push(pos);
        lastCtrl = null;
        break;
      case "H":
        pos = [rel ? pos[0] + num() : num(), pos[1]];
        cur.push(pos);
        lastCtrl = null;
        break;
      case "V":
        pos = [pos[0], rel ? pos[1] + num() : num()];
        cur.push(pos);
        lastCtrl = null;
        break;
      case "C": {
        const c1 = at(num(), num());
        const c2 = at(num(), num());
        const end = at(num(), num());
        cubic(pos, c1, c2, end, cur);
        lastCtrl = c2;
        pos = end;
        break;
      }
      case "S": {
        const c1: Pt = lastCtrl ? [2 * pos[0] - lastCtrl[0], 2 * pos[1] - lastCtrl[1]] : pos;
        const c2 = at(num(), num());
        const end = at(num(), num());
        cubic(pos, c1, c2, end, cur);
        lastCtrl = c2;
        pos = end;
        break;
      }
      case "Q": {
        const c = at(num(), num());
        const end = at(num(), num());
        quad(pos, c, end, cur);
        lastCtrl = c;
        pos = end;
        break;
      }
      case "T": {
        const c: Pt = lastCtrl ? [2 * pos[0] - lastCtrl[0], 2 * pos[1] - lastCtrl[1]] : pos;
        const end = at(num(), num());
        quad(pos, c, end, cur);
        lastCtrl = c;
        pos = end;
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const end = at(num(), num());
        arc(pos, rx, ry, rot, large, sweep, end, cur);
        pos = end;
        lastCtrl = null;
        break;
      }
      case "Z":
        cur.push(start);
        pos = start;
        flush();
        cur = [pos];
        lastCtrl = null;
        break;
      default:
        i++; // unknown token: skip
    }
    lastCmd = cmd;
  }
  flush();
  return polylines;
}

// ---------------------------------------------------------------- transforms

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
const axisAligned = (m: M) => Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;

function parseTransform(s: string | undefined): M {
  let m = IDENTITY;
  if (!s) return m;
  for (const [, fn, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = (args.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []).map(Number);
    let t: M = IDENTITY;
    switch (fn) {
      case "translate":
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const rot: M = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
        t = a.length >= 3 ? mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]) : rot;
        break;
      }
      case "matrix":
        if (a.length === 6) t = a as M;
        break;
    }
    m = mul(m, t);
  }
  return m;
}

// ---------------------------------------------------------------- tags

/** Containers whose content is not drawn directly (marker shapes, gradients, styles...). */
const SKIP = new Set(["defs", "marker", "clippath", "mask", "pattern", "style", "title", "desc", "metadata", "symbol", "lineargradient", "radialgradient", "filter", "script", "foreignobject"]);

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  // style="a:b; c:d" wins over presentation attributes, as in SVG.
  for (const decl of (out.style ?? "").split(";")) {
    const [k, ...v] = decl.split(":");
    if (k && v.length) out[k.trim().toLowerCase()] = v.join(":").trim();
  }
  return out;
}

const num = (v: string | undefined, fallback = 0) => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : fallback;
};

function inheritPaint(parent: Paint, a: Record<string, string>): Paint {
  const p: Paint = { ...parent };
  if (a.stroke !== undefined) p.stroke = a.stroke;
  if (a.fill !== undefined) p.fill = a.fill;
  if (a["stroke-width"] !== undefined) p.strokeWidth = num(a["stroke-width"], 1);
  if (a["stroke-dasharray"] !== undefined) {
    const parts = a["stroke-dasharray"].split(/[\s,]+/).map(Number).filter(Number.isFinite);
    p.dash = a["stroke-dasharray"] === "none" || !parts.length ? undefined : parts[0] <= 2 ? "dotted" : "dashed";
  }
  const op = (a.opacity !== undefined ? num(a.opacity, 1) : 1) * (a["fill-opacity"] !== undefined && !a.stroke ? num(a["fill-opacity"], 1) : 1);
  if (op !== 1) p.opacity = (parent.opacity ?? 1) * op;
  if (a["data-fill"] !== undefined) p.fillStyle = a["data-fill"];
  if (a["font-size"] !== undefined) p.fontSize = num(a["font-size"], 16);
  if (a["text-anchor"] !== undefined) p.anchor = a["text-anchor"] as Paint["anchor"];
  if (a["font-weight"] !== undefined) p.bold = /bold|[6-9]00/.test(a["font-weight"]);
  return p;
}

function points(list: string | undefined): Pt[] {
  const nums = (list ?? "").match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g)?.map(Number) ?? [];
  const out: Pt[] = [];
  for (let k = 0; k + 1 < nums.length; k += 2) out.push([nums[k], nums[k + 1]]);
  return out;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const pts: Pt[] = [];
  for (let k = 0; k <= 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

const hasMarker = (v: string | undefined) => !!v && v !== "none";

/** Everything drawable in an SVG snippet, in document order, in the SVG's own coordinates. */
export function parseScene(svg: string): Scene {
  const items: SceneItem[] = [];
  const vbRaw = /<svg\b[^>]*?viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1]?.split(/[\s,]+/).map(Number);
  type Frame = { tag: string; m: M; paint: Paint; skip: boolean };
  const stack: Frame[] = [{ tag: "#root", m: IDENTITY, paint: {}, skip: false }];
  let text: { x: number; y: number; m: M; paint: Paint; lines: string[]; cur: string } | null = null;

  const shape = (tag: string, a: Record<string, string>, m: M, paint: Paint) => {
    const sw = paint.strokeWidth !== undefined ? { ...paint, strokeWidth: paint.strokeWidth * scaleOf(m) } : paint;
    const arrowStart = hasMarker(a["marker-start"]) || a["data-arrow"] === "start" || a["data-arrow"] === "both";
    const arrowEnd = hasMarker(a["marker-end"]) || a["data-arrow"] === "end" || a["data-arrow"] === "both";
    const line = (pts: Pt[]) => {
      if (pts.length > 1) items.push({ kind: "line", points: pts.map((p) => apply(m, p)), arrowStart, arrowEnd, paint: sw });
    };
    switch (tag) {
      case "rect": {
        const x = num(a.x);
        const y = num(a.y);
        const w = num(a.width);
        const h = num(a.height);
        if (w <= 0 || h <= 0) return;
        if (axisAligned(m)) {
          const [x0, y0] = apply(m, [x, y]);
          const [x1, y1] = apply(m, [x + w, y + h]);
          items.push({ kind: "rect", x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), rounded: num(a.rx) > 0 || num(a.ry) > 0, paint: sw });
        } else
          line([
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
            [x, y],
          ]);
        return;
      }
      case "circle":
      case "ellipse": {
        const cx = num(a.cx);
        const cy = num(a.cy);
        const rx = tag === "circle" ? num(a.r) : num(a.rx);
        const ry = tag === "circle" ? num(a.r) : num(a.ry, rx);
        if (rx <= 0 || ry <= 0) return;
        if (axisAligned(m)) {
          const [ccx, ccy] = apply(m, [cx, cy]);
          items.push({ kind: "ellipse", cx: ccx, cy: ccy, rx: rx * Math.abs(m[0]), ry: ry * Math.abs(m[3]), paint: sw });
        } else line(ellipsePoints(cx, cy, rx, ry));
        return;
      }
      case "line":
        line([
          [num(a.x1), num(a.y1)],
          [num(a.x2), num(a.y2)],
        ]);
        return;
      case "polyline":
        line(points(a.points));
        return;
      case "polygon": {
        const p = points(a.points);
        if (p.length) line([...p, p[0]]);
        return;
      }
      case "path":
        for (const p of parsePath(a.d ?? "")) line(p);
        return;
    }
  };

  for (const tok of svg.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([a-zA-Z][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [whole, cdata, closing, rawTag, rawAttrs, selfClosing, chars] = tok;
    const top = stack[stack.length - 1];
    if (whole.startsWith("<!--")) continue;
    if (chars !== undefined || cdata !== undefined) {
      if (text && !top.skip) text.cur += decode(chars ?? cdata ?? "");
      continue;
    }
    const tag = rawTag.toLowerCase().replace(/^svg:/, "");
    if (closing) {
      // Pop back to the matching open tag (tolerates sloppy markup).
      const at = stack.map((f) => f.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      if (tag === "text" && text) {
        const lines = [...text.lines, text.cur].map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
        if (lines.length) {
          const sc = scaleOf(text.m);
          const paint = { ...text.paint, fontSize: (text.paint.fontSize ?? 16) * sc };
          const [x, y] = apply(text.m, [text.x, text.y]);
          items.push({ kind: "text", x, y, text: lines.join("\n"), paint });
        }
        text = null;
      }
      continue;
    }
    const a = parseAttrs(rawAttrs);
    const skip = top.skip || SKIP.has(tag);
    const m = mul(top.m, parseTransform(a.transform));
    const paint = inheritPaint(top.paint, a);
    if (!skip) {
      if (tag === "text") text = { x: num(a.x), y: num(a.y), m, paint, lines: [], cur: "" };
      else if (tag === "tspan" && text) {
        // A tspan that moves down starts a new line.
        if ((a.dy !== undefined || a.y !== undefined) && text.cur.trim()) {
          text.lines.push(text.cur);
          text.cur = "";
        }
      } else if (!text) shape(tag, a, m, paint);
    }
    if (!selfClosing && tag !== "br") stack.push({ tag, m, paint, skip });
  }

  return {
    items,
    viewBox: vbRaw && vbRaw.length === 4 && vbRaw.every(Number.isFinite) && vbRaw[2] > 0 && vbRaw[3] > 0 ? { x: vbRaw[0], y: vbRaw[1], w: vbRaw[2], h: vbRaw[3] } : undefined,
  };
}
