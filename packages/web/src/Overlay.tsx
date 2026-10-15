import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  AI_COLOR,
  type AgentState,
  type AIEdge,
  type AINode,
  type BBox,
  type Candidate,
  type Comment,
  type OntologyType,
  type SavedView,
  type Settings,
  sinapsiData,
  type ViewDef,
  viewMatches,
} from "@sinapsi/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardModel } from "./board";
import {
  center,
  elementBBox,
  findFreeSpot,
  isOnScreen,
  rectsOverlap,
  type ScreenRect,
  segmentHitsRect,
  toScreen,
  union,
  type Viewport,
} from "./geometry";
import { useNow, useYMap } from "./hooks";
import { useSavedViews } from "./registry";
import { ViewCard } from "./ViewCard";

interface Props {
  model: BoardModel;
  viewport: Viewport;
  lens: boolean;
  /** Always draw the outline around each idea; otherwise only on hover / open / while Claude works on it. */
  showBoxes: boolean;
  elements: Map<string, ExcalidrawElement>;
}

const GRAY = "#868e96";
/** Below this zoom the board is read from afar: only big titles. */
const FAR_ZOOM = 0.5;
/** Relation labels only when close enough to read them. */
const EDGE_LABEL_ZOOM = 0.7;
const CHIP_H = 24;

const BUILD_ICON: Record<string, string> = {
  idle: "⏸",
  waiting: "⏳",
  building: "⚙",
  done: "✓",
  error: "!",
  question: "?",
};

/** full = type + name, short = name only, icon = just the type icon (name on hover). */
type Placed = { left: number; top: number; size: "full" | "short" | "icon" };

/**
 * The AI layer drawn on top of the canvas. Ordering rules: drawings own the
 * canvas, so the layer never covers them if it can avoid it; chips dodge each
 * other; comments wait in a badge; views open on demand (or when pinned) in free
 * space; zoomed out, only big titles remain.
 */
export function Overlay({ model, viewport: v, lens, showBoxes, elements }: Props) {
  const candidates = useYMap(model.candidates);
  const nodes = useYMap(model.nodes);
  const edges = useYMap(model.edges);
  const ontology = useYMap(model.ontology);
  const comments = useYMap(model.comments);
  const views = useYMap(model.views);
  const agentMap = useYMap(model.agent);
  const settingsMap = useYMap(model.settings);
  const proposalMap = useYMap(model.proposal);
  const now = useNow(1000);
  const [openId, setOpenId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** Views opened here on demand / pinned views closed here. Local to this screen. */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [closedPinned, setClosedPinned] = useState<Set<string>>(new Set());
  const savedViews = useSavedViews();

  const mode = (settingsMap.get("mode") as Settings["mode"]) ?? "implicit";
  const agent = agentMap.get("state") as AgentState | undefined;
  const agentFocus = agent && now - agent.lastSeen < 6000 ? agent.nodeId : undefined;
  const far = v.zoom < FAR_ZOOM;

  const typeOf = (n?: AINode): OntologyType | undefined => (n ? ontology.get(n.type) : undefined);
  const colorOf = (n?: AINode) => typeOf(n)?.color ?? GRAY;

  const isOpen = (view: ViewDef) => (view.pinned ? !closedPinned.has(view.id) : opened.has(view.id));
  const toggleView = (view: ViewDef) => {
    if (isOpen(view)) {
      if (view.pinned) setClosedPinned(new Set([...closedPinned, view.id]));
      setOpened(new Set([...opened].filter((id) => id !== view.id)));
    } else {
      setClosedPinned(new Set([...closedPinned].filter((id) => id !== view.id)));
      setOpened(new Set([...opened, view.id]));
    }
  };

  const threads = useMemo(() => {
    const byNode = new Map<string, Comment[]>();
    for (const c of comments.values()) {
      if (!c.nodeId) continue;
      const list = byNode.get(c.nodeId) ?? [];
      list.push(c);
      byNode.set(c.nodeId, list);
    }
    for (const list of byNode.values()) list.sort((a, b) => a.at - b.at);
    return byNode;
  }, [comments]);

  const { ghosts, occupied } = useMemo(() => {
    const groups = new Map<string, BBox[]>();
    const occ: BBox[] = [];
    for (const el of elements.values()) {
      if (el.isDeleted) continue;
      const b = elementBBox(el as Parameters<typeof elementBBox>[0]);
      occ.push(b);
      const s = sinapsiData(el as { customData?: Record<string, unknown> });
      if (!s?.ghost || !s.ghostGroup) continue;
      const list = groups.get(s.ghostGroup) ?? [];
      list.push(b);
      groups.set(s.ghostGroup, list);
    }
    return { ghosts: [...groups].map(([id, boxes]) => ({ id, box: union(boxes) })), occupied: occ };
  }, [elements]);

  const cands = [...candidates.values()];
  const shapes = cands.filter((c) => c.kind !== "link");
  const links = cands.filter((c) => c.kind === "link");
  const inferred = [...edges.values()].filter((e) => !candidates.has(e.id) && e.status !== "rejected");
  const visible = shapes
    .map((c) => ({ c, node: nodes.get(c.id), r: toScreen(c.bbox, v) }))
    .filter((x) => x.node && x.node.status !== "rejected" && isOnScreen(x.r, v))
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left) as { c: Candidate; node: AINode; r: ScreenRect }[];

  // What overlay labels must not cover (screen coords): arrows and lines (theirs and Claude's),
  // Claude's drawings, and other ideas.
  const toScreenPt = (x: number, y: number) => ({ x: (x + v.scrollX) * v.zoom, y: (y + v.scrollY) * v.zoom });
  const segs: [{ x: number; y: number }, { x: number; y: number }][] = [];
  const aiRects: BBox[] = [];
  if (!far && lens) {
    const wireIds = new Set(links.map((l) => l.elementIds[0]));
    for (const el of elements.values()) {
      if (el.isDeleted) continue;
      const linear = el.type === "arrow" || el.type === "line" || (el.type === "freedraw" && wireIds.has(el.id));
      if (linear && "points" in el && el.points) {
        const pts = el.points.filter((_, i, all) => i % 4 === 0 || i === all.length - 1).map(([px, py]) => toScreenPt(el.x + px, el.y + py));
        for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
      } else if (sinapsiData(el as { customData?: Record<string, unknown> })?.author === "ai") {
        const b = elementBBox(el as Parameters<typeof elementBBox>[0]);
        const r = toScreen(b, v);
        aiRects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
  }
  const nodeRects = visible.map(({ c, r }) => ({ id: c.id, rect: { x: r.left, y: r.top, w: r.width, h: r.height } }));
  /** How many things a label at `rect` would cover (0 = free). Other ideas count most. */
  const cost = (rect: BBox, selfId: string, placed: BBox[]) =>
    placed.filter((p) => rectsOverlap(p, rect)).length * 2 +
    aiRects.filter((a) => rectsOverlap(a, rect, 2)).length * 2 +
    nodeRects.filter((n) => n.id !== selfId && rectsOverlap(n.rect, rect, 2)).length * 4 +
    segs.filter(([p, q]) => segmentHitsRect(p, q, rect)).length;
  const blocked = (rect: BBox, selfId: string, placed: BBox[]) => cost(rect, selfId, placed) > 0;

  // Chips dodge each other, arrows and drawings: above, below, beside — else shrink to an icon.
  const chips = new Map<string, Placed>();
  const chipRects: BBox[] = [];
  if (!far && lens) {
    for (const { c, node, r } of visible) {
      const hasView = views.has(`v_${c.id}`);
      const w = Math.min(320, 52 + (node.type.length + node.label.length) * 6.6 + (node.assumptions.length ? 24 : 0) + (hasView ? 26 : 0));
      const options = [
        { x: r.left - 6, y: r.top - 10 - CHIP_H },
        { x: r.left + r.width - w + 6, y: r.top - 10 - CHIP_H },
        { x: r.left - 6, y: r.top + r.height + 6 },
        { x: r.left + r.width - w + 6, y: r.top + r.height + 6 },
        { x: r.left + r.width + 8, y: r.top },
        { x: r.left - w - 8, y: r.top },
      ];
      // Try the full chip, then the name alone, then just the icon, at every spot.
      const shortW = Math.min(260, 34 + node.label.length * 6.6 + (hasView ? 26 : 0));
      let placed: Placed | undefined;
      let width = 34;
      for (const [size, sw] of [
        ["full", w],
        ["short", shortW],
        ["icon", 34],
      ] as const) {
        const o = options.find((opt) => !blocked({ x: opt.x, y: opt.y, w: sw, h: CHIP_H }, c.id, chipRects));
        if (o) {
          placed = { left: o.x, top: o.y, size };
          width = sw;
          break;
        }
      }
      if (!placed) {
        // Nowhere is free: the icon goes where it covers the least.
        const o = [...options].sort((a, b) => cost({ ...a, w: 34, h: CHIP_H }, c.id, chipRects) - cost({ ...b, w: 34, h: CHIP_H }, c.id, chipRects))[0];
        placed = { left: o.x, top: o.y, size: "icon" };
      }
      chipRects.push({ x: placed.left, y: placed.top, w: width, h: CHIP_H });
      chips.set(c.id, placed);
    }
  }

  // Comment badges get the same treatment, after the chips.
  const badgeSpot = (id: string, r: ScreenRect) => {
    const w = 46;
    const h = 22;
    const options = [
      { x: r.left - 4, y: r.top + r.height + 4 },
      { x: r.left + r.width - w + 4, y: r.top + r.height + 4 },
      { x: r.left + r.width + 6, y: r.top + r.height - h },
      { x: r.left - w - 6, y: r.top + r.height - h },
    ];
    const pos =
      options.find((o) => !blocked({ x: o.x, y: o.y, w, h }, id, chipRects)) ??
      [...options].sort((a, b) => cost({ ...a, w, h }, id, chipRects) - cost({ ...b, w, h }, id, chipRects))[0];
    chipRects.push({ x: pos.x, y: pos.y, w, h });
    return pos;
  };

  // Views: open ones go to free space next to their node (never over drawings or chips).
  const viewPlacement = new Map<string, { left: number; top: number; offset: { dx: number; dy: number } }>();
  if (!far) {
    const occ = [
      ...occupied,
      ...chipRects.map((r) => ({ x: r.x / v.zoom - v.scrollX, y: r.y / v.zoom - v.scrollY, w: r.w / v.zoom, h: r.h / v.zoom })),
    ];
    const open = [...views.values()]
      .filter((view) => isOpen(view) && nodes.has(view.nodeId) && candidates.has(view.nodeId))
      .sort((a, b) => candidates.get(a.nodeId)!.bbox.y - candidates.get(b.nodeId)!.bbox.y);
    for (const view of open) {
      const b = candidates.get(view.nodeId)!.bbox;
      const size = { w: view.width, h: view.height + 34 };
      const base = { x: b.x + b.w + 28, y: b.y };
      const pos =
        view.dx !== undefined || view.dy !== undefined
          ? { x: base.x + (view.dx ?? 0), y: base.y + (view.dy ?? 0) }
          : findFreeSpot(occ, size.w, size.h, b, 28, 12);
      occ.push({ ...pos, ...size });
      viewPlacement.set(view.id, {
        left: (pos.x + v.scrollX) * v.zoom,
        top: (pos.y + v.scrollY) * v.zoom,
        offset: { dx: pos.x - base.x, dy: pos.y - base.y },
      });
    }
  }

  const proposal = proposalMap.get("current");
  const openNode = openId ? nodes.get(openId) : undefined;
  const openCand = openId ? candidates.get(openId) : undefined;
  const openView = openId ? views.get(`v_${openId}`) : undefined;

  if (far) {
    // Zoomed out: one big title per node, the biggest first, never overlapping.
    const placed: BBox[] = [];
    const titles = [...visible]
      .sort((a, b) => b.c.bbox.w * b.c.bbox.h - a.c.bbox.w * a.c.bbox.h)
      .flatMap(({ c, node, r }) => {
        const w = Math.min(260, 40 + node.label.length * 9);
        const ctr = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const rect = { x: ctr.x - w / 2, y: ctr.y - 16, w, h: 32 };
        if (placed.some((p) => rectsOverlap(p, rect, 6))) return [];
        placed.push(rect);
        return [{ c, node, ctr }];
      });
    return (
      <div className="overlay">
        {lens &&
          titles.map(({ c, node, ctr }) => (
            <button
              key={c.id}
              type="button"
              className="far-title"
              style={{ left: ctr.x, top: ctr.y, borderColor: colorOf(node) }}
              onClick={() => setOpenId(c.id)}
            >
              <span>{typeOf(node)?.icon ?? "◆"}</span> {node.label}
            </button>
          ))}
        {proposal && <ProposalLayer proposal={proposal} candidates={candidates} v={v} model={model} />}
      </div>
    );
  }

  return (
    <div className="overlay">
      {lens && (
        <svg className="overlay-svg" width={v.width} height={v.height} aria-hidden="true">
          {inferred.map((e) => {
            const a = candidates.get(e.from);
            const b = candidates.get(e.to);
            if (!a || !b) return null;
            const p = center(a.bbox);
            const q = center(b.bbox);
            const sx = (p.x + v.scrollX) * v.zoom;
            const sy = (p.y + v.scrollY) * v.zoom;
            const ex = (q.x + v.scrollX) * v.zoom;
            const ey = (q.y + v.scrollY) * v.zoom;
            const mx = (sx + ex) / 2 - (ey - sy) * 0.15;
            const my = (sy + ey) / 2 + (ex - sx) * 0.15;
            return <path key={e.id} d={`M${sx},${sy} Q${mx},${my} ${ex},${ey}`} className={`inferred-edge ${e.status}`} stroke={AI_COLOR} />;
          })}
        </svg>
      )}

      {visible.map(({ c, node, r }) => {
        const stale = node.hash !== c.hash;
        const color = colorOf(node);
        const chip = chips.get(c.id);
        const thread = threads.get(c.id);
        const view = views.get(`v_${c.id}`);
        return (
          <div key={c.id}>
            {lens && (showBoxes || hoverId === c.id || openId === c.id || agentFocus === c.id) && (
              <div
                className={`ai-outline ${node.status} ${agentFocus === c.id ? "focus" : ""}`}
                style={{ left: r.left - 6, top: r.top - 6, width: r.width + 12, height: r.height + 12, borderColor: color, color }}
              />
            )}
            {lens && chip && (
              <NodeChip
                node={node}
                type={typeOf(node)}
                color={color}
                stale={stale}
                pos={chip}
                hybrid={mode === "hybrid"}
                view={view}
                viewOpen={view ? isOpen(view) : false}
                onToggleView={() => view && toggleView(view)}
                onOpen={() => setOpenId(openId === c.id ? null : c.id)}
                onHover={(on) => setHoverId(on ? c.id : null)}
                onConfirm={() => model.confirmNode(c.id)}
                onReject={() => model.rejectNode(c.id)}
              />
            )}
            {node.build && node.build.state !== "idle" && (
              <button
                type="button"
                className={`build-badge ${node.build.state}`}
                style={{ left: r.left + r.width + 6, top: r.top - 6 }}
                title={node.build.message ?? node.build.state}
                onClick={() => setOpenId(c.id)}
              >
                {BUILD_ICON[node.build.state]}
              </button>
            )}
            {thread && <CommentBadge thread={thread} pos={badgeSpot(c.id, r)} onOpen={() => setOpenId(c.id)} />}
          </div>
        );
      })}

      {/* Comments on things nobody interpreted yet (e.g. an @AI question) still get a badge. */}
      {shapes
        .filter((c) => !nodes.has(c.id) && threads.has(c.id))
        .map((c) => {
          const r = toScreen(c.bbox, v);
          return isOnScreen(r, v) ? <CommentBadge key={c.id} thread={threads.get(c.id)!} pos={badgeSpot(c.id, r)} onOpen={() => setOpenId(c.id)} /> : null;
        })}

      {lens &&
        v.zoom >= EDGE_LABEL_ZOOM &&
        links.map((l) => {
          const e = edges.get(l.id);
          if (!e || e.status === "rejected") return null;
          const r = toScreen(l.bbox, v);
          if (!isOnScreen(r, v)) return null;
          return <EdgeChip key={l.id} edge={e} x={r.left + r.width / 2} y={r.top + r.height / 2 + 22} hybrid={mode === "hybrid"} model={model} />;
        })}

      {lens &&
        v.zoom >= EDGE_LABEL_ZOOM &&
        inferred.map((e) => {
          const a = candidates.get(e.from);
          const b = candidates.get(e.to);
          if (!a || !b) return null;
          const p = center(a.bbox);
          const q = center(b.bbox);
          const mid = { x: (p.x + q.x) / 2 - (q.y - p.y) * 0.075, y: (p.y + q.y) / 2 + (q.x - p.x) * 0.075 };
          return (
            <EdgeChip
              key={e.id}
              edge={e}
              x={(mid.x + v.scrollX) * v.zoom}
              y={(mid.y + v.scrollY) * v.zoom}
              hybrid={mode === "hybrid"}
              model={model}
              inferred
            />
          );
        })}

      {ghosts.map((g) => {
        const r = toScreen(g.box, v);
        if (!isOnScreen(r, v)) return null;
        return (
          <div key={g.id} className="ghost-bar" style={{ left: r.left, top: r.top - 12 }}>
            <span>✳ Idea di Claude</span>
            <button type="button" onClick={() => model.acceptGhost(g.id)}>
              ✓ Tieni
            </button>
            <button type="button" onClick={() => model.rejectGhost(g.id)}>
              ✕
            </button>
          </div>
        );
      })}

      {[...viewPlacement].map(([id, place]) => {
        const view = views.get(id)!;
        const node = nodes.get(view.nodeId)!;
        return (
          <ViewCard
            key={id}
            view={view}
            node={node}
            color={colorOf(node)}
            left={place.left}
            top={place.top}
            offset={place.offset}
            zoom={v.zoom}
            onEdit={(patch) => model.viewEdit(view.nodeId, patch)}
            onMove={(dx, dy) => model.moveView(view.id, dx, dy)}
            onSaved={(name) => model.setViewSource(view.id, name)}
            onPin={() => model.pinView(view.id, !view.pinned)}
            onClose={() => toggleView(view)}
            author={model.collab.me.name}
          />
        );
      })}

      {proposal && <ProposalLayer proposal={proposal} candidates={candidates} v={v} model={model} />}

      {openId && openCand && (
        <NodeCard
          key={openId}
          cand={openCand}
          node={openNode}
          type={typeOf(openNode)}
          ontology={[...ontology.values()]}
          thread={threads.get(openId) ?? []}
          rect={toScreen(openCand.bbox, v)}
          viewport={v}
          view={openView}
          viewOpen={openView ? isOpen(openView) : false}
          onToggleView={() => openView && toggleView(openView)}
          onPinView={() => openView && model.pinView(openView.id, !openView.pinned)}
          savedViews={savedViews}
          onApplyView={(saved) => {
            model.applyView(openId, saved);
            setClosedPinned(new Set([...closedPinned].filter((id) => id !== `v_${openId}`)));
            setOpened(new Set([...opened, `v_${openId}`]));
          }}
          model={model}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NodeChip(props: {
  node: AINode;
  type?: OntologyType;
  color: string;
  stale: boolean;
  pos: Placed;
  hybrid: boolean;
  view?: ViewDef;
  viewOpen: boolean;
  onToggleView: () => void;
  onOpen: () => void;
  onHover: (on: boolean) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const { node, type, color, stale, pos, hybrid, view, viewOpen, onToggleView, onOpen, onHover, onConfirm, onReject } = props;
  const proposed = node.status === "proposed";
  const title = `${node.type} · ${node.label}${node.summary ? `\n${node.summary}` : ""}`;
  if (pos.size === "icon") {
    return (
      <button
        type="button"
        className="node-chip compact"
        style={{ left: pos.left, top: pos.top, borderColor: color }}
        onClick={onOpen}
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
        title={title}
      >
        <span className="chip-type" style={{ background: color }}>
          {type?.icon ?? "◆"}
        </span>
      </button>
    );
  }
  return (
    <div
      className={`node-chip ${proposed ? "proposed" : ""} ${stale ? "stale" : ""}`}
      style={{ left: pos.left, top: pos.top, borderColor: color }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <button type="button" className="chip-main" onClick={onOpen} title={title}>
        <span className="chip-type" style={{ background: color }}>
          {type?.icon ?? "◆"}
          {pos.size === "full" ? ` ${node.type}` : ""}
        </span>
        <span className="chip-label">{node.label}</span>
        {node.by === "user" && (
          <span className="chip-flag" title="Corretto da un umano">
            ✎
          </span>
        )}
        {node.assumptions.length > 0 && (
          <span className="chip-flag warn" title={node.assumptions.join("\n")}>
            ⚠{node.assumptions.length}
          </span>
        )}
        {stale && (
          <span className="chip-flag" title="Modificato: Claude lo rileggerà">
            ↻
          </span>
        )}
      </button>
      {view && (
        <button type="button" className={`chip-act view ${viewOpen ? "on" : ""}`} onClick={onToggleView} title={viewOpen ? "Chiudi la vista" : `Apri la vista «${view.title}»`}>
          ▣
        </button>
      )}
      {proposed && hybrid && (
        <>
          <button type="button" className="chip-act ok" onClick={onConfirm} title="Conferma">
            ✓
          </button>
          <button type="button" className="chip-act no" onClick={onReject} title="Non è così">
            ✕
          </button>
        </>
      )}
    </div>
  );
}

function CommentBadge({ thread, pos, onOpen }: { thread: Comment[]; pos: { x: number; y: number }; onOpen: () => void }) {
  const last = thread[thread.length - 1];
  const asking = last.author === "ai" && last.kind === "question";
  const preview = last.text.length > 140 ? `${last.text.slice(0, 139)}…` : last.text;
  return (
    <button
      type="button"
      className={`comment-badge ${asking ? "asking" : ""} ${last.author === "ai" ? "ai" : ""}`}
      style={{ left: pos.x, top: pos.y }}
      onClick={onOpen}
      title={`${last.author === "ai" ? "Claude" : last.authorName}: ${preview}`}
    >
      {asking ? "❓" : "💬"} {thread.length}
    </button>
  );
}

function EdgeChip(props: { edge: AIEdge; x: number; y: number; hybrid: boolean; model: BoardModel; inferred?: boolean }) {
  const { edge, x, y, hybrid, model, inferred } = props;
  const proposed = edge.status === "proposed";
  return (
    <div className={`edge-chip ${proposed ? "proposed" : ""} ${inferred ? "inferred" : ""}`} style={{ left: x, top: y }}>
      <span title={edge.label}>{edge.type}</span>
      {proposed && hybrid && (
        <>
          <button type="button" onClick={() => model.confirmEdge(edge.id)} title="Conferma">
            ✓
          </button>
          <button type="button" onClick={() => model.rejectEdge(edge.id)} title="Scarta">
            ✕
          </button>
        </>
      )}
    </div>
  );
}

/** Ghost preview of a tidy-up: where each node would go, and a bar to apply or discard. */
function ProposalLayer({
  proposal,
  candidates,
  v,
  model,
}: {
  proposal: { title: string; by: "ai" | "user"; moves: { nodeId: string; dx: number; dy: number }[] };
  candidates: Map<string, Candidate>;
  v: Viewport;
  model: BoardModel;
}) {
  const moves = proposal.moves.filter((m) => candidates.has(m.nodeId));
  return (
    <>
      <svg className="overlay-svg" width={v.width} height={v.height} aria-hidden="true">
        {moves.map((m) => {
          const b = candidates.get(m.nodeId)!.bbox;
          const from = toScreen(b, v);
          const to = toScreen({ ...b, x: b.x + m.dx, y: b.y + m.dy }, v);
          return (
            <g key={m.nodeId} className="proposal-move">
              <line x1={from.left + from.width / 2} y1={from.top + from.height / 2} x2={to.left + to.width / 2} y2={to.top + to.height / 2} />
              <rect x={to.left} y={to.top} width={to.width} height={to.height} rx={8} />
            </g>
          );
        })}
      </svg>
      <div className="proposal-bar">
        <span>
          ✳ {proposal.by === "ai" ? proposal.title : "Anteprima del riordino"} · {moves.length} {moves.length === 1 ? "elemento" : "elementi"}
        </span>
        <button type="button" className="btn ok" onClick={() => model.applyProposal()}>
          Applica
        </button>
        <button type="button" className="btn ghost" onClick={() => model.rejectProposal()}>
          Scarta
        </button>
      </div>
    </>
  );
}

function NodeCard(props: {
  cand: Candidate;
  node?: AINode;
  type?: OntologyType;
  ontology: OntologyType[];
  thread: Comment[];
  rect: ScreenRect;
  viewport: Viewport;
  view?: ViewDef;
  viewOpen: boolean;
  onToggleView: () => void;
  onPinView: () => void;
  savedViews: SavedView[];
  onApplyView: (v: SavedView) => void;
  model: BoardModel;
  onClose: () => void;
}) {
  const { cand, node, type, ontology, thread, rect, viewport, view, viewOpen, onToggleView, onPinView, model, onClose } = props;
  const compatible = node
    ? props.savedViews
        .filter((sv) => viewMatches(sv, node.props))
        .sort((a, b) => Number(b.types.includes(node.type)) - Number(a.types.includes(node.type)))
    : [];
  const ref = useRef<HTMLDivElement>(null);
  const [newType, setNewType] = useState(node?.type ?? "");
  const [newLabel, setNewLabel] = useState(node?.label ?? "");
  const [reply, setReply] = useState("");

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const width = 320;
  const left = Math.min(Math.max(8, rect.left), viewport.width - width - 8);
  const top = Math.min(Math.max(8, rect.top + rect.height + 16), viewport.height - 120);
  const lastQuestion = [...thread].reverse().find((c) => c.author === "ai");
  const changed = node && (newType.trim() !== node.type || newLabel.trim() !== node.label);

  return (
    <div ref={ref} className="node-card" style={{ left, top, width }} onWheel={(e) => e.stopPropagation()}>
      <div className="card-head" style={{ background: type?.color ?? GRAY }}>
        <span>
          {type?.icon ?? "◆"} {node ? `${node.type} · ${node.label}` : "Non ancora interpretato"}
        </span>
        <button type="button" onClick={onClose} aria-label="Chiudi">
          ×
        </button>
      </div>
      <div className="card-body">
        <p className="muted small">Visto come: {cand.summary}</p>
        {node?.summary && <p className="card-summary">{node.summary}</p>}

        {node && Object.keys(node.props).length > 0 && (
          <dl className="props">
            {Object.entries(node.props).map(([k, val]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{typeof val === "object" ? JSON.stringify(val) : String(val)}</dd>
              </div>
            ))}
          </dl>
        )}

        {node && node.assumptions.length > 0 && (
          <div className="assumptions">
            <strong>Ipotesi di Claude</strong>
            <ul>
              {node.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        )}

        {node?.build && (
          <div className={`build-line ${node.build.state}`}>
            <span>
              {BUILD_ICON[node.build.state]} {node.build.message ?? node.build.state}
            </span>
            {node.build.files?.length ? (
              <ul className="files">
                {node.build.files.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {view && (
          <div className="row view-controls">
            <button type="button" className="btn" onClick={onToggleView}>
              {viewOpen ? "Chiudi la vista" : `▣ Apri «${view.title}»`}
            </button>
            <button type="button" className={`btn ${view.pinned ? "ok" : "ghost"}`} onClick={onPinView} title="Una vista fissata è aperta per tutti">
              {view.pinned ? "📌 Fissata" : "📌 Fissa"}
            </button>
          </div>
        )}

        {compatible.length > 0 && (
          <div className="saved-views">
            <strong>Viste salvate compatibili</strong>
            {compatible.map((sv) => (
              <div key={sv.name} className="saved-view">
                <div>
                  <b>{sv.title}</b>
                  {sv.description && <span className="muted small"> · {sv.description}</span>}
                </div>
                <button type="button" className="btn" disabled={view?.source === sv.name} onClick={() => props.onApplyView(sv)}>
                  {view?.source === sv.name ? "In uso" : "Applica"}
                </button>
              </div>
            ))}
          </div>
        )}

        {node && (
          <form
            className="retype"
            onSubmit={(e) => {
              e.preventDefault();
              if (changed && newType.trim()) model.retypeNode(node.id, newType.trim(), newLabel.trim() || node.label);
            }}
          >
            <strong>Non è così? Correggi</strong>
            <div className="row">
              <input list="ontology-types" value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="tipo" />
              <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="nome" />
            </div>
            <datalist id="ontology-types">
              {ontology.map((t) => (
                <option key={t.name} value={t.name} />
              ))}
            </datalist>
            <div className="row">
              {node.status === "proposed" && (
                <button type="button" className="btn ok" onClick={() => model.confirmNode(node.id)}>
                  ✓ Conferma
                </button>
              )}
              <button type="submit" className="btn" disabled={!changed}>
                Correggi
              </button>
              {node.status !== "rejected" && (
                <button type="button" className="btn ghost" onClick={() => model.rejectNode(node.id)}>
                  Ignora
                </button>
              )}
            </div>
          </form>
        )}

        <div className="thread">
          {thread.map((c) => (
            <div key={c.id} className={`msg ${c.author}`}>
              <span className="who">{c.author === "ai" ? "✳ Claude" : c.authorName}</span>
              <span>{c.text}</span>
            </div>
          ))}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reply.trim()) return;
              model.reply(reply.trim(), { nodeId: cand.id, replyTo: lastQuestion?.id });
              setReply("");
            }}
          >
            <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Scrivi a Claude…" />
            <button type="submit" className="btn">
              Invia
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
