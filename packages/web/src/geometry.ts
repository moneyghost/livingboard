import type { BBox } from "@sinapsi/shared";

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
}

export type ScreenRect = { left: number; top: number; width: number; height: number };

export function toScreen(b: BBox, v: Viewport): ScreenRect {
  return {
    left: (b.x + v.scrollX) * v.zoom,
    top: (b.y + v.scrollY) * v.zoom,
    width: b.w * v.zoom,
    height: b.h * v.zoom,
  };
}

export function isOnScreen(r: ScreenRect, v: Viewport, margin = 200): boolean {
  return r.left + r.width > -margin && r.top + r.height > -margin && r.left < v.width + margin && r.top < v.height + margin;
}

type Geo = { x: number; y: number; width: number; height: number; points?: readonly (readonly [number, number])[] };

export function elementBBox(el: Geo): BBox {
  if (el.points?.length) {
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: el.x + minX, y: el.y + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  return { x: el.x, y: el.y, w: el.width, h: el.height };
}

export function union(boxes: BBox[]): BBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
}

export function center(b: BBox) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

const overlapsAny = (b: BBox, occupied: BBox[], pad: number) =>
  occupied.some((o) => b.x < o.x + o.w + pad && b.x + b.w + pad > o.x && b.y < o.y + o.h + pad && b.y + b.h + pad > o.y);

/** First free slot around an anchor (right, below, left, above), sliding along when busy. Scene units. */
export function findFreeSpot(occupied: BBox[], w: number, h: number, anchor?: BBox, gap = 60, pad = 20): { x: number; y: number } {
  if (!anchor) {
    if (!occupied.length) return { x: 0, y: 0 };
    const maxX = Math.max(...occupied.map((o) => o.x + o.w));
    const minY = Math.min(...occupied.map((o) => o.y));
    anchor = { x: maxX + gap, y: minY, w: 0, h: 0 };
  }
  const tries: [number, number, number, number][] = [
    [anchor.x + anchor.w + gap, anchor.y, 0, 1],
    [anchor.x, anchor.y + anchor.h + gap, 1, 0],
    [anchor.x - w - gap, anchor.y, 0, 1],
    [anchor.x, anchor.y - h - gap, 1, 0],
  ];
  for (const [x0, y0, sx, sy] of tries) {
    for (let k = 0; k < 8; k++) {
      const b = { x: x0 + sx * k * (w * 0.5 + 20), y: y0 + sy * k * (h * 0.5 + 20), w, h };
      if (!overlapsAny(b, occupied, pad)) return b;
    }
  }
  return { x: anchor.x + anchor.w + gap, y: anchor.y };
}

type Pt = { x: number; y: number };

/** Does segment p→q cross rectangle r? (Liang–Barsky) */
export function segmentHitsRect(p: Pt, q: Pt, r: BBox): boolean {
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
  return clip(-dx, p.x - r.x) && clip(dx, r.x + r.w - p.x) && clip(-dy, p.y - r.y) && clip(dy, r.y + r.h - p.y);
}

/** Do two screen/scene rectangles overlap (with padding)? */
export function rectsOverlap(a: BBox, b: BBox, pad = 4) {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}
