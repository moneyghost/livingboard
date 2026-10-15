/**
 * Just enough SVG to let the agent sketch: turns <path>, <line>, <polyline>,
 * <polygon>, <rect>, <circle> and <ellipse> into polylines that become
 * hand-drawn strokes on the board. Arcs are approximated by a straight segment
 * (the tool description tells the agent to use curves instead).
 */

export type Pt = [number, number];

export interface SvgStroke {
  points: Pt[];
  color?: string;
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
        num();
        num();
        num();
        num();
        num();
        pos = at(num(), num());
        cur.push(pos);
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

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag);
  return m ? m[1] : undefined;
};
const n = (tag: string, name: string) => Number(attr(tag, name) ?? 0);

function ellipse(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const pts: Pt[] = [];
  for (let k = 0; k <= 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

function points(list: string | undefined): Pt[] {
  const nums = (list ?? "").match(/-?(?:\d+\.?\d*|\.\d+)/g)?.map(Number) ?? [];
  const out: Pt[] = [];
  for (let k = 0; k + 1 < nums.length; k += 2) out.push([nums[k], nums[k + 1]]);
  return out;
}

/** Strokes from an SVG snippet, plus its viewBox when present. */
export function parseSvg(svg: string): { strokes: SvgStroke[]; viewBox?: { x: number; y: number; w: number; h: number } } {
  const strokes: SvgStroke[] = [];
  const vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(svg)?.[1]?.split(/[\s,]+/).map(Number);
  for (const m of svg.matchAll(/<(path|line|polyline|polygon|rect|circle|ellipse)\b[^>]*>/g)) {
    const tag = m[0];
    const color = attr(tag, "stroke") ?? attr(tag, "fill");
    const c = color && color !== "none" ? color : undefined;
    switch (m[1]) {
      case "path":
        for (const p of parsePath(attr(tag, "d") ?? "")) strokes.push({ points: p, color: c });
        break;
      case "line":
        strokes.push({ points: [[n(tag, "x1"), n(tag, "y1")], [n(tag, "x2"), n(tag, "y2")]], color: c });
        break;
      case "polyline":
        strokes.push({ points: points(attr(tag, "points")), color: c });
        break;
      case "polygon": {
        const p = points(attr(tag, "points"));
        if (p.length) strokes.push({ points: [...p, p[0]], color: c });
        break;
      }
      case "rect": {
        const x = n(tag, "x");
        const y = n(tag, "y");
        const w = n(tag, "width");
        const h = n(tag, "height");
        strokes.push({ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], color: c });
        break;
      }
      case "circle":
        strokes.push({ points: ellipse(n(tag, "cx"), n(tag, "cy"), n(tag, "r"), n(tag, "r")), color: c });
        break;
      case "ellipse":
        strokes.push({ points: ellipse(n(tag, "cx"), n(tag, "cy"), n(tag, "rx"), n(tag, "ry")), color: c });
        break;
    }
  }
  return {
    strokes: strokes.filter((s) => s.points.length > 1),
    viewBox: vb && vb.length === 4 && vb.every(Number.isFinite) ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : undefined,
  };
}
