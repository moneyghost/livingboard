import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AI_COLOR,
  type Activity,
  type AgentState,
  type AIEdge,
  type AINode,
  type BoardFile,
  type BoardStyle,
  type Candidate,
  type Comment,
  DEFAULT_SETTINGS,
  type DocSection,
  DOC,
  type ExplicitGroup,
  type Feedback,
  isAiAuthored,
  type LayoutProposal,
  sinapsiData,
  type OntologyType,
  type Settings,
  STABILITY_MS,
  footprint,
  slugify,
  treeLayout,
  type ViewDef,
  uid,
} from "@sinapsi/shared";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { DATA_DIR } from "./config";
import { boardsDir, parseBoardKey, type Project } from "./projects";
import { type El, elementBBox, segment, unionBBox } from "./segment";
import { YRoom } from "./yserver";

const SERVER = "server";

/** What an agent drawing says (texts, parts, images), ignoring where it is. */
function drawingSnapshot(els: El[]) {
  const live = els.filter((e) => !e.isDeleted);
  const texts = live.map((e) => e.originalText ?? e.text ?? "").filter(Boolean);
  const sig = JSON.stringify(live.map((e) => [e.type, e.originalText ?? e.text ?? "", (e as El & { fileId?: string }).fileId ?? ""]).sort());
  return { sig, texts };
}
const AGENT_IDLE_MS = 120_000;
/** Bump when the candidate hash changes meaning (v2: content, not element versions). */
const HASH_VERSION = 2;
const MAX_ACTIVITY = 150;

const PALETTE = ["#4c6ef5", "#12b886", "#f59f00", "#e64980", "#7950f2", "#15aabf", "#fd7e14", "#40c057", "#fa5252", "#228be6"];

export interface ChangeReport {
  board: string;
  settings: Settings;
  policy: string;
  style: BoardStyle;
  changes: unknown[];
  links: unknown[];
  removed: unknown[];
  feedback: unknown[];
  /** Agent drawings people changed (text edited, parts deleted, erased): the board moved, the project should follow. */
  drawingEdits: unknown[];
  idle: boolean;
  hint: string;
}

/** One agent drawing, as the agent sees it in the overview. */
export interface DrawingInfo {
  drawingId: string;
  kind?: string;
  title?: string;
  nodeId?: string;
  bbox: { x: number; y: number; w: number; h: number };
  texts: string[];
}

export class Board {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly room: YRoom;

  readonly elements = this.doc.getMap<El>(DOC.elements);
  readonly candidates = this.doc.getMap<Candidate>(DOC.candidates);
  readonly nodes = this.doc.getMap<AINode>(DOC.nodes);
  readonly edges = this.doc.getMap<AIEdge>(DOC.edges);
  readonly ontology = this.doc.getMap<OntologyType>(DOC.ontology);
  readonly comments = this.doc.getMap<Comment>(DOC.comments);
  readonly views = this.doc.getMap<ViewDef>(DOC.views);
  readonly settingsMap = this.doc.getMap<unknown>(DOC.settings);
  readonly agent = this.doc.getMap<unknown>(DOC.agent);
  readonly feedback = this.doc.getArray<Feedback>(DOC.feedback);
  readonly activity = this.doc.getArray<Activity>(DOC.activity);
  readonly groups = this.doc.getMap<ExplicitGroup>(DOC.groups);
  readonly docSections = this.doc.getMap<DocSection>(DOC.doc);
  readonly proposal = this.doc.getMap<LayoutProposal>(DOC.proposal);
  readonly files = this.doc.getMap<BoardFile>(DOC.files);

  /** Candidate id → hash the agent has already seen. */
  private reported = new Map<string, string>();
  /** Things that disappeared since the agent last looked. */
  private removed = new Map<string, unknown>();
  private feedbackCursor = 0;
  private settingsDirty = false;
  private waiters = new Set<() => void>();
  private recomputeTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private glideTimer: NodeJS.Timeout | null = null;
  private labelTimer: NodeJS.Timeout | null = null;
  private cursor = { x: 0, y: 0 };
  private listeningCount = 0;
  /** Agent drawing id → the content the agent last knew (texts, parts, images). */
  private drawingSigs = new Map<string, { sig: string; texts: string[] }>();
  /** Agent drawings a person touched, and when: reported once they settle, if their content changed. */
  private touchedDrawings = new Map<string, number>();

  /** The board's name as people and the agent know it (without the project). */
  readonly label: string;
  readonly project: Project | undefined;

  /** `name` is the board key: `main`, or `<project id>:<board>` for a project's board. */
  constructor(readonly name: string) {
    const k = parseBoardKey(name);
    this.label = k.name;
    this.project = k.project;
    this.room = new YRoom(this.doc, this.awareness);
    this.load();

    this.doc.transact(() => {
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!this.settingsMap.has(k)) this.settingsMap.set(k, v);
      this.agent.set("state", { listening: false, lastSeen: 0 } satisfies AgentState);
      // Image data nothing points at any more (not even a deleted element someone could restore).
      const used = new Set([...this.elements.values()].map((e) => (e as El & { fileId?: string }).fileId).filter(Boolean));
      for (const id of [...this.files.keys()]) if (!used.has(id)) this.files.delete(id);
    }, SERVER);
    this.awareness.setLocalState(null);

    for (const c of this.candidates.values()) if (c.state === "read") this.reported.set(c.id, c.hash);
    this.feedbackCursor = this.feedback.length;

    for (const [id, els] of this.drawingGroups()) this.drawingSigs.set(id, drawingSnapshot(els));
    this.elements.observe((event, tr) => {
      this.scheduleRecompute();
      const touched = new Set<string>();
      for (const k of event.keysChanged) {
        const id = sinapsiData(this.elements.get(k) ?? {})?.drawingId;
        if (id) touched.add(id);
      }
      if (!touched.size) return;
      if (tr.origin === SERVER) {
        const groups = this.drawingGroups(true);
        for (const id of touched) this.drawingSigs.set(id, drawingSnapshot(groups.get(id) ?? []));
      } else for (const id of touched) this.touchedDrawings.set(id, Date.now());
    });
    this.settingsMap.observe((_e, tr) => {
      if (tr.origin === SERVER) return;
      this.settingsDirty = true;
      this.updateAttention();
      this.wake();
    });
    this.feedback.observe(() => this.wake());
    this.groups.observe(() => this.scheduleRecompute());
    this.doc.on("update", () => this.scheduleSave());
    setInterval(() => this.tick(), 400).unref();
    this.scheduleRecompute();
  }

  // ---------------------------------------------------------------- persistence

  private get file() {
    if (this.project) return join(boardsDir(this.project), `${this.label}.ydoc`);
    return join(DATA_DIR, `${this.label}.ydoc`);
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      Y.applyUpdate(this.doc, readFileSync(this.file), SERVER);
    } catch (err) {
      console.error(`[board:${this.name}] cannot load`, err);
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, Y.encodeStateAsUpdate(this.doc));
    }, 1000);
  }

  // ---------------------------------------------------------------- reading

  settings(): Settings {
    return { ...DEFAULT_SETTINGS, ...(Object.fromEntries(this.settingsMap.entries()) as Partial<Settings>) };
  }

  liveElements(): El[] {
    return [...this.elements.values()].filter((e) => !e.isDeleted);
  }

  candidate(id: string) {
    return this.candidates.get(id);
  }

  private scheduleRecompute() {
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null;
      this.recompute();
    }, 200);
  }

  /** Re-run the geometric pre-pass and sync candidates into the doc. */
  /** Run the pre-pass now (tools that regroup want to answer with the new candidates). */
  recomputeNow() {
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
    this.recomputeTimer = null;
    this.recompute();
  }

  private recompute() {
    const now = Date.now();
    const prev = new Map(this.candidates.entries());
    const explicit = new Map<string, string>();
    for (const g of this.groups.values()) for (const id of g.elementIds) explicit.set(id, g.id);
    const next = segment([...this.elements.values()], prev, now, explicit);
    const nextIds = new Set(next.map((c) => c.id));

    // Boards saved with an older hash: a node read over exactly the same elements keeps its
    // reading, so the agent is not asked to re-read the whole board after an upgrade.
    if (this.agent.get("hashVersion") !== HASH_VERSION) {
      const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
      this.doc.transact(() => {
        for (const c of next) {
          const node = this.nodes.get(c.id);
          if (!node || node.hash === c.hash || !same(node.elementIds, c.elementIds)) continue;
          this.nodes.set(c.id, { ...node, hash: c.hash });
          this.reported.set(c.id, c.hash);
          c.state = "read";
        }
        this.agent.set("hashVersion", HASH_VERSION);
      }, SERVER);
    }

    this.doc.transact(() => {
      for (const [id, old] of prev) {
        if (nextIds.has(id)) continue;
        this.candidates.delete(id);
        const node = this.nodes.get(id);
        if (this.reported.has(id) || node) {
          this.removed.set(id, {
            id,
            kind: old.kind,
            summary: old.summary,
            interpretation: node ? { type: node.type, label: node.label, files: node.build?.files ?? [] } : null,
          });
        }
        this.reported.delete(id);
        if (node) this.nodes.delete(id);
        for (const [eid, e] of this.edges) if (e.from === id || e.to === id || eid === id) this.edges.delete(eid);
        const view = this.views.get(`v_${id}`);
        if (view) this.views.delete(view.id);
      }
      for (const c of next) {
        const old = prev.get(c.id);
        if (!old || old.hash !== c.hash || JSON.stringify(old.bbox) !== JSON.stringify(c.bbox) || old.parentId !== c.parentId) {
          this.candidates.set(c.id, c);
        }
        // A reading made for a different set of strokes (e.g. before a split) is misleading: drop it.
        const node = this.nodes.get(c.id);
        if (node) {
          const mine = new Set(c.elementIds);
          const overlap = node.elementIds.filter((id) => mine.has(id)).length;
          if (overlap < 0.5 * Math.max(node.elementIds.length, c.elementIds.length)) {
            this.removed.set(c.id, {
              id: c.id,
              kind: c.kind,
              summary: "interpretazione superata: il nodo è stato diviso o riunito",
              interpretation: { type: node.type, label: node.label, files: node.build?.files ?? [] },
            });
            this.nodes.delete(c.id);
            this.reported.delete(c.id);
            const view = this.views.get(`v_${c.id}`);
            if (view) this.views.delete(view.id);
          }
        }
      }
    }, SERVER);
    this.updateAttention();
    if (this.removed.size) this.wake();
  }

  /** Element ids someone is typing into right now: never read half-written text. */
  private busyElements(): Set<string> {
    const busy = new Set<string>();
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID || !state) continue;
      const editing = (state as { editing?: string[] }).editing;
      for (const id of editing ?? []) busy.add(id);
    }
    return busy;
  }

  private updateAttention() {
    const now = Date.now();
    const { effort } = this.settings();
    const stability = STABILITY_MS[effort];
    const busy = this.busyElements();
    let anyReady = false;
    this.doc.transact(() => {
      for (const c of this.candidates.values()) {
        let state: Candidate["state"];
        let matureAt = c.matureAt;
        if (this.reported.get(c.id) === c.hash) state = "read";
        else if (effort === "low" && c.kind !== "question") state = "quiet";
        else if (c.elementIds.some((id) => busy.has(id))) {
          state = "maturing";
          matureAt = now + stability;
        } else {
          matureAt = Math.max(c.changedAt + stability, c.state === "maturing" ? (c.matureAt ?? 0) : 0);
          state = now >= matureAt ? "ready" : "maturing";
        }
        if (state === "ready") anyReady = true;
        if (state !== c.state || matureAt !== c.matureAt) this.candidates.set(c.id, { ...c, state, matureAt });
      }
    }, SERVER);
    if (anyReady) this.wake();
  }

  private tick() {
    this.updateAttention();
    if ([...this.touchedDrawings.values()].some((t) => Date.now() - t > STABILITY_MS[this.settings().effort])) this.wake();
    const st = this.agent.get("state") as AgentState | undefined;
    if (st && this.listeningCount === 0 && st.lastSeen && Date.now() - st.lastSeen > AGENT_IDLE_MS && this.awareness.getLocalState()) {
      this.awareness.setLocalState(null);
    }
  }

  private wake() {
    for (const w of [...this.waiters]) w();
  }

  // ---------------------------------------------------------------- agent presence

  touchAgent(activity?: string, nodeId?: string) {
    const prev = (this.agent.get("state") as AgentState | undefined) ?? { listening: false, lastSeen: 0 };
    this.doc.transact(() => {
      this.agent.set("state", {
        ...prev,
        listening: this.listeningCount > 0,
        lastSeen: Date.now(),
        activity: activity ?? prev.activity,
        nodeId: nodeId ?? prev.nodeId,
      } satisfies AgentState);
    }, SERVER);
    if (!this.awareness.getLocalState()) {
      this.awareness.setLocalState({
        user: { name: "Claude", color: AI_COLOR, ai: true },
        pointer: { x: this.cursor.x, y: this.cursor.y, tool: "pointer" },
      });
    }
    if (activity) this.setCursorLabel(activity);
  }

  private setCursorLabel(label: string) {
    const st = this.awareness.getLocalState();
    if (!st) return;
    this.awareness.setLocalState({ ...st, activity: label });
    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.labelTimer = setTimeout(() => {
      const s = this.awareness.getLocalState();
      if (s) this.awareness.setLocalState({ ...s, activity: undefined });
    }, 5000);
  }

  /** Glide the AI cursor toward a candidate, so humans see where Claude is looking. */
  glideTo(id: string | undefined, tool: "pointer" | "laser" = "pointer") {
    const c = id ? this.candidates.get(id) : undefined;
    if (!c) return;
    const target = { x: c.bbox.x + c.bbox.w * 0.8, y: c.bbox.y + c.bbox.h * 0.2 };
    const start = { ...this.cursor };
    const steps = 14;
    let i = 0;
    if (this.glideTimer) clearInterval(this.glideTimer);
    this.glideTimer = setInterval(() => {
      i++;
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.cursor = { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e };
      const st = this.awareness.getLocalState();
      if (st) this.awareness.setLocalState({ ...st, pointer: { ...this.cursor, tool } });
      if (i >= steps && this.glideTimer) {
        clearInterval(this.glideTimer);
        this.glideTimer = null;
      }
    }, 30);
  }

  log(text: string, kind: Activity["kind"], nodeId?: string) {
    this.doc.transact(() => {
      this.activity.push([{ id: uid("a_"), at: Date.now(), text, nodeId, kind }]);
      if (this.activity.length > MAX_ACTIVITY) this.activity.delete(0, this.activity.length - MAX_ACTIVITY);
    }, SERVER);
  }

  // ---------------------------------------------------------------- describing

  policy(s = this.settings()): string {
    const effort = {
      low: "Effort BASSO: rispondi solo alle domande (@AI) e ai commenti. Non interpretare né costruire altro.",
      medium: "Effort MEDIO: interpreta ogni candidato maturo e costruisci ciò che è chiaro.",
      high: "Effort ALTO: interpreta, costruisci e proponi idee per le lacune evidenti con draw(ghost: true).",
    }[s.effort];
    const permission = {
      read: "Permessi SOLA LETTURA: non modificare file né sistemi esterni. Solo interpret, comment, draw, attach_view.",
      ask: "Permessi CHIEDI: prima di costruire qualcosa chiedi con comment(kind: 'question') e aspetta una risposta positiva nel feedback.",
      auto: "Permessi AUTO: esegui azioni reversibili (file sotto git) senza chiedere; chiedi prima di quelle irreversibili (pubblicare, cancellare, inviare).",
    }[s.permission];
    const mode = {
      hybrid: "Modalità IBRIDA: le tue interpretazioni sono proposte. Costruisci un nodo solo quando il feedback dice che l'utente l'ha confermato.",
      implicit: "Modalità IMPLICITA: le tue interpretazioni valgono subito. Mostra le ipotesi (assumptions) così l'utente può correggerti.",
    }[s.mode];
    const drawing =
      "Lavagna = progetto: tienila sempre allineata al progetto, in entrambe le direzioni. Quello che costruisci o decidi lo disegni (draw_svg per schermate, oggetti, schemi; draw_table per confronti, elenchi con attributi, stati; draw_chart per numeri; extend per alberi; draw_diagram per flussi); quando cambia lo aggiorni con replace: drawingId, non aggiungi copie; quando è superato lo cancelli con erase. Le modifiche che le persone fanno ai tuoi disegni (drawingEdits) sono istruzioni sul progetto. Al massimo 20 parole per elemento; il Documento (write_doc) solo per testi lunghi.";
    return [mode, effort, permission, drawing].join("\n");
  }

  private nodeBrief(n: AINode | undefined) {
    if (!n) return null;
    return {
      type: n.type,
      label: n.label,
      status: n.status,
      by: n.by,
      props: n.props,
      build: n.build ? { state: n.build.state, files: n.build.files } : undefined,
    };
  }

  describe(c: Candidate) {
    const node = this.nodes.get(c.id);
    const parent = c.parentId ? this.candidates.get(c.parentId) : undefined;
    const links = [...this.candidates.values()]
      .filter((l) => l.kind === "link" && (l.from === c.id || l.to === c.id))
      .map((l) => {
        const out = l.from === c.id;
        const other = this.candidates.get(out ? l.to! : l.from!);
        return { id: l.id, dir: out ? "out" : "in", other: other?.id, otherSummary: other?.summary, label: l.texts[0] };
      });
    return {
      id: c.id,
      kind: c.kind,
      change: this.reported.has(c.id) ? "modified" : "new",
      summary: c.summary,
      texts: c.texts,
      bbox: c.bbox,
      parent: parent ? { id: parent.id, summary: parent.summary } : undefined,
      links: links.length ? links : undefined,
      needsVision: c.needsVision || undefined,
      hint:
        c.kind === "sketch" && c.elementIds.length >= 60
          ? `Molti tratti (${c.elementIds.length}): se sono più idee guardalo e dividilo con split_node.`
          : undefined,
      interpretation: node ? { ...this.nodeBrief(node), stale: node.hash !== c.hash } : null,
    };
  }

  describeLink(l: Candidate) {
    const from = this.candidates.get(l.from!);
    const to = this.candidates.get(l.to!);
    return {
      id: l.id,
      change: this.reported.has(l.id) ? "modified" : "new",
      label: l.texts[0],
      from: { id: l.from, summary: from?.summary },
      to: { id: l.to, summary: to?.summary },
      interpretation: this.edges.get(l.id) ?? null,
    };
  }

  private describeFeedback(f: Feedback) {
    const node = f.nodeId ? this.nodes.get(f.nodeId) : undefined;
    const comment = f.commentId ? this.comments.get(f.commentId) : undefined;
    const parent = comment?.replyTo ? this.comments.get(comment.replyTo) : undefined;
    return {
      kind: f.kind,
      user: f.user,
      nodeId: f.nodeId,
      edgeId: f.edgeId,
      node: node ? { type: node.type, label: node.label, status: node.status } : undefined,
      comment: comment ? { id: comment.id, text: comment.text, inReplyTo: parent?.text } : undefined,
      data: f.data,
    };
  }

  overview() {
    const s = this.settings();
    const cands = [...this.candidates.values()];
    return {
      board: this.label,
      settings: s,
      policy: this.policy(s),
      ontology: [...this.ontology.values()],
      candidates: cands.filter((c) => c.kind !== "link").map((c) => ({
        id: c.id,
        kind: c.kind,
        summary: c.summary,
        parent: c.parentId,
        state: c.state,
        interpretation: this.nodeBrief(this.nodes.get(c.id)),
      })),
      links: cands.filter((c) => c.kind === "link").map((l) => ({ id: l.id, from: l.from, to: l.to, label: l.texts[0] })),
      edges: [...this.edges.values()].map((e) => ({ id: e.id, from: e.from, to: e.to, type: e.type, status: e.status })),
      comments: [...this.comments.values()].sort((a, b) => a.at - b.at).slice(-30),
      views: [...this.views.values()].map((v) => ({ id: v.id, nodeId: v.nodeId, title: v.title })),
      style: this.style(),
      document: [...this.docSections.values()].sort((a, b) => a.order - b.order).map((d) => ({ title: d.title, nodeIds: d.nodeIds })),
      drawings: this.drawings(),
    };
  }

  // ---------------------------------------------------------------- agent drawings

  /** Agent drawings by id (live elements only, unless `withDeleted`). */
  private drawingGroups(withDeleted = false) {
    const out = new Map<string, El[]>();
    for (const e of this.elements.values()) {
      const id = sinapsiData(e)?.drawingId;
      if (!id || (!withDeleted && e.isDeleted)) continue;
      const list = out.get(id) ?? [];
      list.push(e);
      out.set(id, list);
    }
    return out;
  }

  private describeDrawing(id: string, els: El[]): DrawingInfo {
    const meta = sinapsiData(els[0]) ?? { author: "ai" as const };
    const live = els.filter((e) => !e.isDeleted);
    const b = live.length ? unionBBox(live.map(elementBBox)) : { x: 0, y: 0, w: 0, h: 0 };
    return {
      drawingId: id,
      kind: meta.kind,
      title: meta.title,
      nodeId: meta.nodeId,
      bbox: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) },
      texts: live
        .map((e) => e.originalText ?? e.text ?? "")
        .filter(Boolean)
        .slice(0, 40),
    };
  }

  /** Every drawing the agent made that is still on the board: what it can update or erase. */
  drawings(): DrawingInfo[] {
    return [...this.drawingGroups()].map(([id, els]) => this.describeDrawing(id, els));
  }

  /** Live elements of one agent drawing; throws if there is none. */
  drawingElements(id: string): El[] {
    const els = this.drawingGroups().get(id);
    if (!els?.length) throw new Error(`${id}: disegno sconosciuto o già cancellato (vedi drawings in board_overview).`);
    return els;
  }

  /** Remove agent drawings (soft delete, like Excalidraw: undo still works for people). */
  eraseDrawings(ids: string[]) {
    const groups = this.drawingGroups();
    let count = 0;
    this.doc.transact(() => {
      for (const id of ids) {
        for (const e of groups.get(id) ?? []) {
          this.elements.set(e.id, { ...e, isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } as El);
          count++;
        }
      }
    }, SERVER);
    return count;
  }

  /** How people draw here: the agent mimics it so its drawings feel native. */
  style(): BoardStyle {
    const human = this.liveElements().filter((e) => !isAiAuthored(e));
    const colors = new Map<string, number>();
    for (const e of human) {
      const c = e.strokeColor;
      if (c && c !== "transparent") colors.set(c, (colors.get(c) ?? 0) + (e.type === "freedraw" ? 1 : 3));
    }
    const ink = [...colors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "#1e1e1e";
    const strokes = human.filter((e) => e.type === "freedraw");
    const texts = human.filter((e) => e.type === "text");
    const handwriting = strokes.length > texts.length * 3;
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
    const letterH = median(strokes.map((e) => e.height).filter((h) => h >= 6 && h <= 80));
    const fontSizes = texts.map((e) => Number((e as unknown as { fontSize?: number }).fontSize ?? 20));
    const raw = handwriting ? letterH * 1.1 : median(fontSizes) || 20;
    const cands = [...this.candidates.values()];
    const shapes = cands.filter((c) => c.kind === "shape").length;
    const others = cands.filter((c) => c.kind === "sketch" || c.kind === "text").length;
    const links = cands.filter((c) => c.kind === "link");
    const handLinks = links.filter((l) => this.elements.get(l.elementIds[0])?.type === "freedraw").length;
    return {
      ink,
      handwriting,
      textSize: Math.round(Math.min(40, Math.max(14, raw || 20))),
      nodes: shapes > others ? "boxes" : "words",
      arrows: links.length === 0 ? "none" : handLinks * 2 >= links.length ? "hand" : "arrows",
    };
  }

  /** Main direction of the arrows leaving a node (to continue a structure the same way). */
  directionOf(nodeId: string): "down" | "right" | "up" | "left" {
    const c = this.candidates.get(nodeId);
    if (!c) return "down";
    const from = { x: c.bbox.x + c.bbox.w / 2, y: c.bbox.y + c.bbox.h / 2 };
    let dx = 0;
    let dy = 0;
    for (const l of this.candidates.values()) {
      if (l.kind !== "link" || l.from !== nodeId) continue;
      const t = this.candidates.get(l.to!);
      if (!t) continue;
      dx += t.bbox.x + t.bbox.w / 2 - from.x;
      dy += t.bbox.y + t.bbox.h / 2 - from.y;
    }
    if (dx === 0 && dy === 0) return "down";
    return Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? "down" : "up") : dx >= 0 ? "right" : "left";
  }

  writeDoc(input: { section: string; markdown?: string; nodeIds?: string[]; remove?: boolean }) {
    const id = slugify(input.section);
    if (input.remove) {
      this.doc.transact(() => this.docSections.delete(id), SERVER);
      return id;
    }
    const old = this.docSections.get(id);
    this.doc.transact(() => {
      this.docSections.set(id, {
        id,
        title: input.section.trim(),
        markdown: (input.markdown ?? "").trim(),
        nodeIds: input.nodeIds ?? old?.nodeIds,
        by: "ai",
        order: old?.order ?? this.docSections.size,
        updatedAt: Date.now(),
      });
    }, SERVER);
    this.touchAgent("scrive il Documento");
    this.log(`Ha ${old ? "aggiornato" : "scritto"} «${input.section}» nel Documento`, "info");
    return id;
  }

  /** Compute a tidy tree layout and leave it as a proposal people can preview and apply. */
  proposeLayout(title: string, by: LayoutProposal["by"]) {
    const attached = new Map<string, ReturnType<typeof elementBBox>[]>();
    for (const e of this.liveElements()) {
      const owner = isAiAuthored(e) && e.type !== "arrow" ? sinapsiData(e)?.nodeId : undefined;
      if (owner) attached.set(owner, [...(attached.get(owner) ?? []), elementBBox(e)]);
    }
    const nodes = [...this.candidates.values()]
      .filter((c) => c.kind !== "link" && c.kind !== "frame")
      .map((c) => ({ id: c.id, bbox: footprint(c.bbox, attached.get(c.id) ?? []) }));
    const edges = [
      ...[...this.candidates.values()].filter((c) => c.kind === "link").map((l) => ({ from: l.from!, to: l.to! })),
      ...[...this.edges.values()].filter((e) => e.status !== "rejected").map((e) => ({ from: e.from, to: e.to })),
    ];
    const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
    const fixed = [
      ...nodes.filter((n) => !linked.has(n.id)).map((n) => n.bbox),
      ...this.liveElements()
        .filter((e) => isAiAuthored(e) && !linked.has(sinapsiData(e)?.nodeId ?? ""))
        .map(elementBBox),
    ];
    const moves = treeLayout(nodes, edges, fixed);
    if (!moves.length) throw new Error("Niente da riordinare: servono nodi collegati da frecce, oppure è già in ordine.");
    const p: LayoutProposal = { id: uid("lay_"), title, moves, by, at: Date.now() };
    this.doc.transact(() => this.proposal.set("current", p), SERVER);
    return p;
  }

  // ---------------------------------------------------------------- waiting

  async waitForChanges(timeoutMs: number, signal?: AbortSignal): Promise<ChangeReport> {
    this.listeningCount++;
    this.touchAgent("in ascolto");
    try {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const report = this.collect();
        if (report) return report;
        const left = deadline - Date.now();
        if (left <= 0 || signal?.aborted) break;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.waiters.delete(done);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, left);
          this.waiters.add(done);
          signal?.addEventListener("abort", done);
        });
      }
      return {
        board: this.label,
        settings: this.settings(),
        policy: this.policy(),
        style: this.style(),
        changes: [],
        links: [],
        removed: [],
        feedback: [],
        drawingEdits: [],
        idle: true,
        hint: "Nessuna novità. Richiama wait_for_changes per continuare ad ascoltare.",
      };
    } finally {
      this.listeningCount--;
      this.touchAgent();
    }
  }

  /** Agent drawings people changed and then left alone: only real content changes (moving one is not news). */
  private settledDrawingEdits() {
    const settled = [...this.touchedDrawings].filter(([, t]) => Date.now() - t > STABILITY_MS[this.settings().effort]).map(([id]) => id);
    if (!settled.length) return [];
    const groups = this.drawingGroups(true);
    const edits: unknown[] = [];
    for (const id of settled) {
      this.touchedDrawings.delete(id);
      const els = groups.get(id) ?? [];
      const now = drawingSnapshot(els);
      const before = this.drawingSigs.get(id);
      if (now.sig === before?.sig) continue;
      this.drawingSigs.set(id, now);
      const info = this.describeDrawing(id, els);
      const erased = !els.some((e) => !e.isDeleted);
      // What text appeared and disappeared (a cell rewritten shows up as one of each).
      const left = [...(before?.texts ?? [])];
      const added: string[] = [];
      for (const t of now.texts) {
        const i = left.indexOf(t);
        if (i >= 0) left.splice(i, 1);
        else added.push(t);
      }
      edits.push({ ...info, change: erased ? "erased" : "edited", added, removed: left });
    }
    return edits;
  }

  /**
   * What wait_for_changes would report now, counted without consuming it: a
   * nudge for the agent between its turns (the Claude Code prompt hook).
   */
  pending() {
    const ready = [...this.candidates.values()].filter((c) => c.state === "ready");
    const groups = this.touchedDrawings.size ? this.drawingGroups(true) : new Map<string, El[]>();
    const edited = [...this.touchedDrawings.keys()].filter((id) => drawingSnapshot(groups.get(id) ?? []).sig !== this.drawingSigs.get(id)?.sig);
    return {
      ideas: ready.filter((c) => c.kind !== "link").length,
      links: ready.filter((c) => c.kind === "link").length,
      feedback: this.feedback.length - this.feedbackCursor,
      removed: this.removed.size,
      drawingEdits: edited.length,
      /** Changes since a given moment show up as a different signature. */
      sig: [...ready.map((c) => c.id + c.hash), this.feedback.length, ...this.removed.keys(), ...edited].join("|"),
    };
  }

  private collect(): ChangeReport | null {
    const ready = [...this.candidates.values()].filter((c) => c.state === "ready");
    const fb = this.feedback.slice(this.feedbackCursor);
    const drawingEdits = this.settledDrawingEdits();
    if (!ready.length && !fb.length && !this.removed.size && !this.settingsDirty && !drawingEdits.length) return null;

    const changes = ready.filter((c) => c.kind !== "link").map((c) => this.describe(c));
    const links = ready.filter((c) => c.kind === "link").map((c) => this.describeLink(c));
    const removed = [...this.removed.values()];
    const feedback = fb.map((f) => this.describeFeedback(f));

    this.doc.transact(() => {
      for (const c of ready) {
        this.reported.set(c.id, c.hash);
        this.candidates.set(c.id, { ...c, state: "read" });
      }
    }, SERVER);
    this.feedbackCursor = this.feedback.length;
    this.removed.clear();
    this.settingsDirty = false;

    if (changes.length) {
      const first = ready.find((c) => c.kind !== "link");
      this.glideTo(first?.id);
      this.log(`Sta leggendo ${changes.length === 1 ? (changes[0] as { summary: string }).summary : `${changes.length} elementi`}`, "read", first?.id);
    }

    const needVision = (changes as { needsVision?: boolean }[]).some((c) => c.needsVision);
    return {
      board: this.label,
      settings: this.settings(),
      policy: this.policy(),
      style: this.style(),
      changes,
      links,
      removed,
      feedback,
      drawingEdits,
      idle: false,
      hint: [
        needVision ? "Alcuni candidati sono schizzi: guardali con get_board_image(nodeIds) prima di interpretarli." : "",
        drawingEdits.length
          ? "drawingEdits: una persona ha modificato o cancellato i tuoi disegni (added/removed = testi cambiati). È una richiesta di modifica al progetto: adegua il progetto e il resto della lavagna a quello che vedi ora."
          : "",
        "Interpreta con interpret(); poi agisci secondo la policy; poi richiama wait_for_changes.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  // ---------------------------------------------------------------- writing

  interpret(input: {
    nodes?: { id: string; type: string; label: string; summary?: string; props?: Record<string, unknown>; confidence?: number; assumptions?: string[] }[];
    edges?: { id?: string; from?: string; to?: string; type: string; label?: string; confidence?: number }[];
    types?: { name: string; description?: string; color?: string; icon?: string; fields?: Record<string, string> }[];
    remove?: string[];
  }) {
    const { mode } = this.settings();
    const now = Date.now();
    const results: string[] = [];
    const errors: string[] = [];

    this.doc.transact(() => {
      for (const t of input.types ?? []) this.upsertType(t);

      for (const n of input.nodes ?? []) {
        const cand = this.candidates.get(n.id);
        if (!cand) {
          errors.push(`${n.id}: candidato sconosciuto (forse cancellato)`);
          continue;
        }
        const existing = this.nodes.get(n.id);
        const userOwned = existing?.by === "user";
        const type = userOwned ? existing.type : n.type;
        const status: AINode["status"] = userOwned
          ? "confirmed"
          : mode === "implicit"
            ? "confirmed"
            : existing?.status === "confirmed" && existing.type === n.type
              ? "confirmed"
              : "proposed";
        this.nodes.set(n.id, {
          id: n.id,
          elementIds: cand.elementIds,
          type,
          label: n.label,
          summary: n.summary,
          props: { ...(existing?.props ?? {}), ...(n.props ?? {}) },
          confidence: n.confidence ?? 0.8,
          status,
          by: userOwned ? "user" : "ai",
          assumptions: n.assumptions ?? [],
          build: existing?.build,
          hash: cand.hash,
          updatedAt: now,
        });
        if (!this.ontology.has(type)) this.upsertType({ name: type });
        results.push(`${n.id} → ${type} «${n.label}» (${status})`);
      }

      for (const e of input.edges ?? []) {
        const link = e.id ? this.candidates.get(e.id) : undefined;
        const from = e.from ?? link?.from;
        const to = e.to ?? link?.to;
        if (!from || !to || !this.candidates.has(from) || !this.candidates.has(to)) {
          errors.push(`relazione ${e.id ?? `${from}→${to}`}: estremi sconosciuti`);
          continue;
        }
        const id = link?.id ?? e.id ?? `e_${from}_${to}_${e.type.replace(/\W+/g, "_")}`;
        const existing = this.edges.get(id);
        this.edges.set(id, {
          id,
          from,
          to,
          type: e.type,
          label: e.label,
          status: mode === "implicit" || existing?.status === "confirmed" ? "confirmed" : "proposed",
          by: "ai",
          confidence: e.confidence ?? 0.8,
          updatedAt: now,
        });
        results.push(`${id}: ${from} —${e.type}→ ${to}`);
      }

      for (const id of input.remove ?? []) {
        this.nodes.delete(id);
        this.edges.delete(id);
      }
    }, SERVER);

    const first = input.nodes?.[0];
    if (first && this.candidates.has(first.id)) {
      this.glideTo(first.id);
      this.touchAgent(`legge «${first.label}»`, first.id);
      const n = input.nodes!.length;
      this.log(n === 1 ? `Ha letto «${first.label}» come ${first.type}` : `Ha interpretato ${n} elementi`, "interpret", first.id);
    } else this.touchAgent();

    return { mode, results, errors };
  }

  private upsertType(t: { name: string; description?: string; color?: string; icon?: string; fields?: Record<string, string> }) {
    const old = this.ontology.get(t.name);
    this.ontology.set(t.name, {
      name: t.name,
      description: t.description ?? old?.description ?? "",
      color: t.color ?? old?.color ?? PALETTE[this.ontology.size % PALETTE.length],
      icon: t.icon ?? old?.icon ?? "◆",
      fields: t.fields ?? old?.fields,
    });
  }

  setStatus(nodeId: string, state: NonNullable<AINode["build"]>["state"], message?: string, files?: string[]) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Nodo ${nodeId} non interpretato: chiama prima interpret().`);
    this.doc.transact(() => {
      this.nodes.set(nodeId, {
        ...node,
        build: { state, message, files: files ?? node.build?.files, at: Date.now() },
      });
    }, SERVER);
    this.glideTo(nodeId);
    const verb = { idle: "in pausa", waiting: "in attesa", building: "costruisce", done: "ha finito", error: "errore su", question: "ha un dubbio su" }[state];
    this.touchAgent(`${verb} «${node.label}»`, nodeId);
    this.log(`${verb[0].toUpperCase()}${verb.slice(1)} «${node.label}»${message ? `: ${message}` : ""}`, "build", nodeId);
  }

  comment(input: { nodeId?: string; text: string; kind?: Comment["kind"]; replyTo?: string }) {
    if (input.nodeId && !this.candidates.has(input.nodeId)) throw new Error(`Candidato ${input.nodeId} sconosciuto.`);
    const c: Comment = {
      id: uid("cm_"),
      nodeId: input.nodeId ?? (input.replyTo ? this.comments.get(input.replyTo)?.nodeId : undefined),
      author: "ai",
      authorName: "Claude",
      kind: input.kind ?? "note",
      text: input.text,
      replyTo: input.replyTo,
      at: Date.now(),
    };
    this.doc.transact(() => this.comments.set(c.id, c), SERVER);
    this.glideTo(c.nodeId, c.kind === "answer" ? "laser" : "pointer");
    this.touchAgent(c.kind === "question" ? "fa una domanda" : "commenta", c.nodeId);
    this.log(`${c.kind === "question" ? "Chiede" : "Commenta"}: ${c.text.slice(0, 80)}`, "comment", c.nodeId);
    return c.id;
  }

  addElements(created: Record<string, unknown>[]) {
    this.doc.transact(() => {
      for (const el of created) this.elements.set(el.id as string, el as unknown as El);
    }, SERVER);
  }

  /** Store image data (deduplicated by content hash) for image elements. */
  addFile(file: BoardFile) {
    if (this.files.has(file.id)) return;
    this.doc.transact(() => this.files.set(file.id, file), SERVER);
  }

  /**
   * Swap the picture of an image the agent added earlier, in place: same spot
   * and width, height from the new aspect ratio. Human images are off limits.
   */
  replaceImage(id: string, file: BoardFile, aspect: number, caption?: string) {
    const el = this.elements.get(id);
    if (!el || el.isDeleted || el.type !== "image") throw new Error(`${id}: non è un'immagine sulla lavagna.`);
    if (!isAiAuthored(el)) throw new Error(`${id}: l'immagine è di una persona, non la sostituisco. Aggiungine una nuova.`);
    const oldFile = (el as El & { fileId?: string }).fileId;
    const bump = (e: El, patch: Record<string, unknown>) =>
      ({ ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }) as El;
    const height = Math.round(el.width / aspect);
    const groupId = el.groupIds?.[0];
    const label = groupId
      ? [...this.elements.values()].find((e) => e.type === "text" && !e.isDeleted && e.groupIds?.includes(groupId) && isAiAuthored(e))
      : undefined;
    this.doc.transact(() => {
      if (!this.files.has(file.id)) this.files.set(file.id, file);
      this.elements.set(id, bump(el, { fileId: file.id, height, status: "saved" }));
      // The caption sits under the picture: follow its new height, and take the new text if any.
      if (label) {
        const dy = el.y + height + 10 - label.y;
        this.elements.set(label.id, bump(label, caption ? { y: label.y + dy, text: caption, originalText: caption } : { y: label.y + dy }));
      }
      if (oldFile && oldFile !== file.id && ![...this.elements.values()].some((e) => e.id !== id && (e as El & { fileId?: string }).fileId === oldFile)) {
        this.files.delete(oldFile);
      }
    }, SERVER);
    return { width: el.width, height };
  }

  attachView(input: { nodeId: string; title: string; html: string; width?: number; height?: number; source?: string }) {
    if (!this.nodes.has(input.nodeId)) throw new Error(`Nodo ${input.nodeId} non interpretato: chiama prima interpret().`);
    const id = `v_${input.nodeId}`;
    const old = this.views.get(id);
    this.doc.transact(() => {
      this.views.set(id, {
        id,
        nodeId: input.nodeId,
        title: input.title,
        html: input.html,
        width: input.width ?? old?.width ?? 360,
        height: input.height ?? old?.height ?? 280,
        dx: old?.dx,
        dy: old?.dy,
        source: input.source,
        updatedAt: Date.now(),
      });
    }, SERVER);
    this.glideTo(input.nodeId);
    this.touchAgent(`crea la vista «${input.title}»`, input.nodeId);
    this.log(`Ha creato la vista «${input.title}»`, "view", input.nodeId);
    return id;
  }

  /**
   * Declare elements to be one idea. They leave any group they were in; groups
   * left with fewer than two elements disappear.
   */
  group(elementIds: string[], by: ExplicitGroup["by"]): string {
    const ids = [...new Set(elementIds)].filter((id) => this.elements.has(id));
    if (ids.length === 0) throw new Error("Nessun elemento da raggruppare.");
    const id = uid("grp_");
    this.doc.transact(() => {
      this.releaseFromGroups(ids);
      this.groups.set(id, { id, elementIds: ids, by, at: Date.now() });
    }, SERVER);
    return id;
  }

  /** Give elements back to the automatic pre-pass. */
  releaseFromGroups(elementIds: string[]) {
    const drop = new Set(elementIds);
    for (const [gid, g] of [...this.groups.entries()]) {
      const keep = g.elementIds.filter((e) => !drop.has(e));
      if (keep.length === g.elementIds.length) continue;
      if (keep.length < 2) this.groups.delete(gid);
      else this.groups.set(gid, { ...g, elementIds: keep });
    }
  }

  /** Candidate that currently holds an element. */
  candidateOf(elementId: string) {
    for (const c of this.candidates.values()) if (c.kind !== "link" && c.elementIds.includes(elementId)) return c;
    return undefined;
  }

  /** Bounding box of a node, candidate or raw element id. */
  resolveBBox(ref: string) {
    const c = this.candidates.get(ref);
    if (c) return c.bbox;
    const el = this.elements.get(ref);
    if (el && !el.isDeleted) return unionBBox([{ x: el.x, y: el.y, w: el.width, h: el.height }]);
    return undefined;
  }
}

const boards = new Map<string, Board>();

/** Ping every open board so clients refetch the view registry. */
export function notifyRegistryChanged() {
  for (const b of boards.values()) b.doc.transact(() => b.agent.set("registryAt", Date.now()), SERVER);
}

/** By key (see `boardKey` in projects.ts). */
export function getBoard(key = "main"): Board {
  let b = boards.get(key);
  if (!b) {
    const k = parseBoardKey(key);
    if (k.projectId && !k.project) throw new Error(`Progetto sconosciuto: ${k.projectId}`);
    b = new Board(key);
    boards.set(key, b);
  }
  return b;
}

/** Boards of a project currently open on the server. */
export function openBoardsOf(projectId: string): Board[] {
  return [...boards.values()].filter((b) => b.project?.id === projectId);
}
