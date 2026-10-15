import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  type Activity,
  type AIEdge,
  type AINode,
  type Candidate,
  type Comment,
  DOC,
  type DocSection,
  type ExplicitGroup,
  type Feedback,
  type LayoutProposal,
  type OntologyType,
  type SavedView,
  type Settings,
  footprint,
  sinapsiData,
  treeLayout,
  uid,
  type ViewDef,
} from "@sinapsi/shared";
import type * as Y from "yjs";
import type { Collab } from "./collab";
import { elementBBox } from "./geometry";

/** Typed handles on the shared doc + every action a human can take on the AI layer. */
export class BoardModel {
  readonly candidates: Y.Map<Candidate>;
  readonly nodes: Y.Map<AINode>;
  readonly edges: Y.Map<AIEdge>;
  readonly ontology: Y.Map<OntologyType>;
  readonly comments: Y.Map<Comment>;
  readonly views: Y.Map<ViewDef>;
  readonly settings: Y.Map<unknown>;
  readonly agent: Y.Map<unknown>;
  readonly feedback: Y.Array<Feedback>;
  readonly activity: Y.Array<Activity>;
  readonly groups: Y.Map<ExplicitGroup>;
  readonly docSections: Y.Map<DocSection>;
  readonly proposal: Y.Map<LayoutProposal>;

  constructor(
    readonly collab: Collab,
    private getApi: () => ExcalidrawImperativeAPI | null,
  ) {
    const d = collab.doc;
    this.candidates = d.getMap(DOC.candidates);
    this.nodes = d.getMap(DOC.nodes);
    this.edges = d.getMap(DOC.edges);
    this.ontology = d.getMap(DOC.ontology);
    this.comments = d.getMap(DOC.comments);
    this.views = d.getMap(DOC.views);
    this.settings = d.getMap(DOC.settings);
    this.agent = d.getMap(DOC.agent);
    this.feedback = d.getArray(DOC.feedback);
    this.activity = d.getArray(DOC.activity);
    this.groups = d.getMap(DOC.groups);
    this.docSections = d.getMap(DOC.doc);
    this.proposal = d.getMap(DOC.proposal);
  }

  private get user() {
    return this.collab.me.name;
  }

  private push(f: Omit<Feedback, "id" | "at" | "user">) {
    this.feedback.push([{ id: uid("f_"), at: Date.now(), user: this.user, ...f }]);
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.settings.set(key, value);
  }

  confirmNode(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.collab.doc.transact(() => {
      this.nodes.set(id, { ...n, status: "confirmed", updatedAt: Date.now() });
      this.push({ kind: "confirm", nodeId: id });
    });
  }

  rejectNode(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.collab.doc.transact(() => {
      this.nodes.set(id, { ...n, status: "rejected", updatedAt: Date.now() });
      this.push({ kind: "reject", nodeId: id });
    });
  }

  /** Human correction: the type becomes user-owned, the agent keeps it. */
  retypeNode(id: string, type: string, label: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.collab.doc.transact(() => {
      if (!this.ontology.has(type)) {
        this.ontology.set(type, { name: type, description: "Definito da un umano", color: "#868e96", icon: "✎" });
      }
      this.nodes.set(id, { ...n, type, label, status: "confirmed", by: "user", updatedAt: Date.now() });
      this.push({ kind: "retype", nodeId: id, data: { from: { type: n.type, label: n.label }, to: { type, label } } });
    });
  }

  confirmEdge(id: string) {
    const e = this.edges.get(id);
    if (!e) return;
    this.collab.doc.transact(() => {
      this.edges.set(id, { ...e, status: "confirmed" });
      this.push({ kind: "confirm", edgeId: id });
    });
  }

  rejectEdge(id: string) {
    const e = this.edges.get(id);
    if (!e) return;
    this.collab.doc.transact(() => {
      this.edges.set(id, { ...e, status: "rejected" });
      this.push({ kind: "reject", edgeId: id });
    });
  }

  reply(text: string, opts: { nodeId?: string; replyTo?: string }) {
    const c: Comment = {
      id: uid("cm_"),
      nodeId: opts.nodeId,
      author: "user",
      authorName: this.user,
      kind: "reply",
      text,
      replyTo: opts.replyTo,
      at: Date.now(),
    };
    this.collab.doc.transact(() => {
      this.comments.set(c.id, c);
      this.push({ kind: "reply", nodeId: opts.nodeId, commentId: c.id, data: { text } });
    });
  }

  viewEdit(nodeId: string, patch: Record<string, unknown>) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    this.collab.doc.transact(() => {
      this.nodes.set(nodeId, { ...n, props: { ...n.props, ...patch }, updatedAt: Date.now() });
      this.push({ kind: "view-edit", nodeId, data: patch });
    });
  }

  /** "These strokes are one idea": overrides the automatic grouping (members never split, groups never merge). */
  groupAsIdea(elementIds: string[]) {
    if (!elementIds.length) return;
    const id = uid("grp_");
    this.collab.doc.transact(() => {
      this.releaseFromGroups(elementIds);
      this.groups.set(id, { id, elementIds: [...new Set(elementIds)], by: "user", at: Date.now() });
    });
  }

  /** Give elements back to the automatic grouping. */
  releaseFromGroups(elementIds: string[]) {
    const drop = new Set(elementIds);
    this.collab.doc.transact(() => {
      for (const [gid, g] of [...this.groups.entries()]) {
        const keep = g.elementIds.filter((e) => !drop.has(e));
        if (keep.length === g.elementIds.length) continue;
        if (keep.length < 2) this.groups.delete(gid);
        else this.groups.set(gid, { ...g, elementIds: keep });
      }
    });
  }

  isGrouped(elementIds: string[]) {
    const ids = new Set(elementIds);
    for (const g of this.groups.values()) if (g.elementIds.some((e) => ids.has(e))) return true;
    return false;
  }

  /** Pinned views are open for everyone; the others open on demand. */
  pinView(id: string, pinned: boolean) {
    const v = this.views.get(id);
    if (v) this.views.set(id, { ...v, pinned });
  }

  /** Tidy tree layout of what is on the board, left as a proposal to preview. */
  proposeLayout(): boolean {
    const cands = [...this.candidates.values()];
    const attached = new Map<string, ReturnType<typeof elementBBox>[]>();
    for (const e of this.collab.elements.values()) {
      const s = sinapsiData(e as { customData?: Record<string, unknown> });
      if (e.isDeleted || s?.author !== "ai" || !s.nodeId || e.type === "arrow") continue;
      attached.set(s.nodeId, [...(attached.get(s.nodeId) ?? []), elementBBox(e as Parameters<typeof elementBBox>[0])]);
    }
    const nodes = cands
      .filter((c) => c.kind !== "link" && c.kind !== "frame")
      .map((c) => ({ id: c.id, bbox: footprint(c.bbox, attached.get(c.id) ?? []) }));
    const edges = [
      ...cands.filter((c) => c.kind === "link").map((l) => ({ from: l.from!, to: l.to! })),
      ...[...this.edges.values()].filter((e) => e.status !== "rejected").map((e) => ({ from: e.from, to: e.to })),
    ];
    const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
    const aiDrawings = [...this.collab.elements.values()]
      .filter((e) => {
        const s = sinapsiData(e as { customData?: Record<string, unknown> });
        return !e.isDeleted && s?.author === "ai" && !linked.has(s.nodeId ?? "");
      })
      .map((e) => elementBBox(e as Parameters<typeof elementBBox>[0]));
    const fixed = [...nodes.filter((n) => !linked.has(n.id)).map((n) => n.bbox), ...aiDrawings];
    const moves = treeLayout(nodes, edges, fixed);
    if (!moves.length) return false;
    this.proposal.set("current", { id: uid("lay_"), title: "Riordino", moves, by: "user", at: Date.now() });
    return true;
  }

  rejectProposal() {
    const p = this.proposal.get("current");
    if (!p) return;
    this.collab.doc.transact(() => {
      this.proposal.delete("current");
      if (p.by === "ai") this.push({ kind: "layout-reject", data: { title: p.title } });
    });
  }

  /**
   * Move every node of the proposal (a human action, so it is undoable). Arrows
   * between nodes stretch: each point moves by a blend of its two ends' moves.
   */
  applyProposal() {
    const api = this.getApi();
    const p = this.proposal.get("current");
    if (!api || !p) return;
    const zero = { dx: 0, dy: 0 };
    const byNode = new Map(p.moves.map((m) => [m.nodeId, m]));
    const shift = new Map<string, { dx: number; dy: number }>();
    for (const m of p.moves) for (const id of this.candidates.get(m.nodeId)?.elementIds ?? []) shift.set(id, m);
    const warp = new Map<string, { a: { dx: number; dy: number }; b: { dx: number; dy: number } }>();
    for (const l of this.candidates.values()) {
      if (l.kind !== "link") continue;
      const a = byNode.get(l.from!) ?? zero;
      const b = byNode.get(l.to!) ?? zero;
      if (a === zero && b === zero) continue;
      for (const id of l.elementIds) {
        if (shift.has(id)) continue;
        warp.set(id, { a, b });
      }
    }
    const scene = api.getSceneElementsIncludingDeleted();
    // Claude's drawings about a moved node (notes, annotations, extensions) move with it.
    for (const e of scene) {
      const owner = sinapsiData(e as { customData?: Record<string, unknown> })?.nodeId;
      const m = owner ? byNode.get(owner) : undefined;
      if (m && !shift.has(e.id)) shift.set(e.id, m);
    }
    const next = scene.map((e) => {
      const s = shift.get(e.id);
      if (s) return newElementWith(e, { x: e.x + s.dx, y: e.y + s.dy });
      const w = warp.get(e.id);
      if (!w) return e;
      if (!("points" in e) || !e.points || e.points.length < 2) {
        return newElementWith(e, { x: e.x + (w.a.dx + w.b.dx) / 2, y: e.y + (w.a.dy + w.b.dy) / 2 });
      }
      const n = e.points.length - 1;
      const abs = e.points.map(([px, py], i) => {
        const t = i / n;
        return [e.x + px + w.a.dx + (w.b.dx - w.a.dx) * t, e.y + py + w.a.dy + (w.b.dy - w.a.dy) * t] as [number, number];
      });
      const [x0, y0] = abs[0];
      return newElementWith(e as never, { x: x0, y: y0, points: abs.map(([x, y]) => [x - x0, y - y0]) } as never) as typeof e;
    });
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    this.collab.doc.transact(() => {
      this.proposal.delete("current");
      if (p.by === "ai") this.push({ kind: "layout-accept", data: { title: p.title, moved: p.moves.length } });
    });
  }

  setViewSource(id: string, source: string) {
    const v = this.views.get(id);
    if (v) this.views.set(id, { ...v, source });
  }

  /** Put a saved view on a node (replacing its current one). */
  applyView(nodeId: string, saved: SavedView) {
    const id = `v_${nodeId}`;
    const old = this.views.get(id);
    this.collab.doc.transact(() => {
      this.views.set(id, {
        id,
        nodeId,
        title: saved.title,
        html: saved.html,
        width: saved.width,
        height: saved.height,
        dx: old?.dx,
        dy: old?.dy,
        source: saved.name,
        updatedAt: Date.now(),
      });
      this.push({ kind: "view-apply", nodeId, data: { name: saved.name } });
    });
  }

  moveView(id: string, dx: number, dy: number) {
    const v = this.views.get(id);
    if (v) this.views.set(id, { ...v, dx, dy });
  }

  private ghostElements(group: string) {
    const api = this.getApi();
    if (!api) return { api: null, els: [] as ExcalidrawElement[] };
    const els = api.getSceneElementsIncludingDeleted().filter((e) => {
      const s = sinapsiData(e as { customData?: Record<string, unknown> });
      return s?.ghost && s.ghostGroup === group && !e.isDeleted;
    });
    return { api, els };
  }

  acceptGhost(group: string) {
    const { api, els } = this.ghostElements(group);
    if (!api || !els.length) return;
    const ids = new Set(els.map((e) => e.id));
    const texts = els.filter((e) => e.type === "text").map((e) => ("text" in e ? e.text : ""));
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((e) =>
        ids.has(e.id)
          ? newElementWith(e, {
              opacity: 100,
              strokeStyle: "solid",
              customData: { ...e.customData, sinapsi: { author: "ai-accepted" } },
            })
          : e,
      ),
    });
    this.push({ kind: "accept-ghost", data: { texts } });
  }

  rejectGhost(group: string) {
    const { api, els } = this.ghostElements(group);
    if (!api || !els.length) return;
    const ids = new Set(els.map((e) => e.id));
    const texts = els.filter((e) => e.type === "text").map((e) => ("text" in e ? e.text : ""));
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((e) => (ids.has(e.id) ? newElementWith(e, { isDeleted: true }) : e)),
    });
    this.push({ kind: "reject-ghost", data: { texts } });
  }
}
