import type { BBox } from "./index";

export interface LayoutNode {
  id: string;
  bbox: BBox;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface Move {
  nodeId: string;
  dx: number;
  dy: number;
}

/**
 * A node's footprint for layout: the node plus nearby drawings attached to it
 * (an extension, a circle, a check mark), so tidying leaves room for them.
 * Far-away attachments (margin notes on a long leader line) don't count.
 */
export function footprint(node: BBox, attached: BBox[], reach = 250): BBox {
  let x0 = node.x;
  let y0 = node.y;
  let x1 = node.x + node.w;
  let y1 = node.y + node.h;
  for (const a of attached) {
    const dx = Math.max(0, Math.max(node.x, a.x) - Math.min(node.x + node.w, a.x + a.w));
    const dy = Math.max(0, Math.max(node.y, a.y) - Math.min(node.y + node.h, a.y + a.h));
    if (Math.hypot(dx, dy) > reach) continue;
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.w);
    y1 = Math.max(y1, a.y + a.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Tidy tree layout for a hand-drawn board: follows the relations people drew
 * (top-down, children centered under their parent, subtrees never overlap).
 * Nodes without any relation stay where they are, and so does everything in
 * `fixed`: the tree slides right until it clears them. Returns only the moves,
 * so a proposal can be previewed and applied as deltas.
 */
export function treeLayout(nodes: LayoutNode[], edges: LayoutEdge[], fixed: BBox[] = [], gapX = 60, gapY = 110): Move[] {
  // Grow the tree the way people drew it: if their arrows mostly go sideways, lay it out left to right
  // (same algorithm on swapped axes).
  const pos = new Map(nodes.map((n) => [n.id, n.bbox]));
  let horiz = 0;
  let vert = 0;
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    horiz += Math.abs(b.x + b.w / 2 - (a.x + a.w / 2));
    vert += Math.abs(b.y + b.h / 2 - (a.y + a.h / 2));
  }
  if (horiz > vert * 1.2) {
    const swap = (b: BBox): BBox => ({ x: b.y, y: b.x, w: b.h, h: b.w });
    return topDown(
      nodes.map((n) => ({ id: n.id, bbox: swap(n.bbox) })),
      edges,
      fixed.map(swap),
      gapX,
      gapY + 40,
    ).map((m) => ({ nodeId: m.nodeId, dx: m.dy, dy: m.dx }));
  }
  return topDown(nodes, edges, fixed, gapX, gapY);
}

function topDown(nodes: LayoutNode[], edges: LayoutEdge[], fixed: BBox[], gapX: number, gapY: number): Move[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) continue;
    if (!out.get(e.from)?.includes(e.to)) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    if (!incoming.get(e.to)?.includes(e.from)) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  }
  const connected = nodes.filter((n) => out.has(n.id) || incoming.has(n.id));
  if (connected.length < 2) return [];

  const cx = (id: string) => byId.get(id)!.bbox.x + byId.get(id)!.bbox.w / 2;
  const top = (id: string) => byId.get(id)!.bbox.y;

  // Spanning forest: roots first (no parents), then whatever a cycle left unvisited.
  const children = new Map<string, string[]>();
  const depth = new Map<string, number>();
  const roots: string[] = [];
  const visit = (root: string) => {
    roots.push(root);
    depth.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const id = queue.shift()!;
      const kids = (out.get(id) ?? []).filter((k) => !depth.has(k)).sort((a, b) => cx(a) - cx(b));
      for (const k of kids) depth.set(k, depth.get(id)! + 1);
      children.set(id, kids);
      queue.push(...kids);
    }
  };
  const byPosition = (a: string, b: string) => top(a) - top(b) || cx(a) - cx(b);
  for (const n of connected.map((c) => c.id).filter((id) => !incoming.has(id)).sort(byPosition)) visit(n);
  for (const n of connected.map((c) => c.id).sort(byPosition)) if (!depth.has(n)) visit(n);

  const levelHeight = new Map<number, number>();
  for (const [id, d] of depth) levelHeight.set(d, Math.max(levelHeight.get(d) ?? 0, byId.get(id)!.bbox.h));
  const levelTop = new Map<number, number>();
  const originY = Math.min(...roots.map(top));
  for (let d = 0, y = originY; levelHeight.has(d); d++) {
    levelTop.set(d, y);
    y += levelHeight.get(d)! + gapY;
  }

  const widthMemo = new Map<string, number>();
  const width = (id: string): number => {
    const memo = widthMemo.get(id);
    if (memo !== undefined) return memo;
    const kids = children.get(id) ?? [];
    const kidsW = kids.reduce((s, k) => s + width(k), 0) + gapX * Math.max(0, kids.length - 1);
    const w = Math.max(byId.get(id)!.bbox.w, kidsW);
    widthMemo.set(id, w);
    return w;
  };

  const target = new Map<string, { x: number; y: number }>();
  const place = (id: string, left: number) => {
    const n = byId.get(id)!;
    const w = width(id);
    target.set(id, { x: left + (w - n.bbox.w) / 2, y: levelTop.get(depth.get(id)!)! });
    const kids = children.get(id) ?? [];
    const kidsW = kids.reduce((s, k) => s + width(k), 0) + gapX * Math.max(0, kids.length - 1);
    let x = left + (w - kidsW) / 2;
    for (const k of kids) {
      place(k, x);
      x += width(k) + gapX;
    }
  };
  let left = Math.min(...connected.map((n) => n.bbox.x));
  for (const r of roots) {
    place(r, left);
    left += width(r) + gapX * 2;
  }

  // Don't land on what stays put: take the nearest free offset of the whole tree.
  const boxes = [...target].map(([id, p]) => ({ x: p.x, y: p.y, w: byId.get(id)!.bbox.w, h: byId.get(id)!.bbox.h }));
  const pad = 30;
  const hits = (dx: number, dy: number) =>
    boxes.some((b) =>
      fixed.some((f) => b.x + dx < f.x + f.w + pad && b.x + dx + b.w + pad > f.x && b.y + dy < f.y + f.h + pad && b.y + dy + b.h + pad > f.y),
    );
  const offsets: [number, number][] = [];
  for (let i = -20; i <= 40; i++) for (let j = 0; j <= 20; j++) offsets.push([i * 60, j * 60]);
  offsets.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  const [sx, sy] = offsets.find(([dx, dy]) => !hits(dx, dy)) ?? [0, 0];
  for (const p of target.values()) {
    p.x += sx;
    p.y += sy;
  }

  const moves: Move[] = [];
  for (const [id, p] of target) {
    const b = byId.get(id)!.bbox;
    const dx = Math.round(p.x - b.x);
    const dy = Math.round(p.y - b.y);
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moves.push({ nodeId: id, dx, dy });
  }
  return moves;
}
