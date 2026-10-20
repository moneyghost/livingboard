import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AI_COLOR,
  type Activity,
  type AgentState,
  type Approval,
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
  livingboardData,
  type OntologyType,
  type Settings,
  STABILITY_MS,
  footprint,
  slugify,
  treeLayout,
  type ViewDef,
  uid,
} from "@livingboard/shared";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { DATA_DIR } from "./config";
import { boardsDir, parseBoardKey, type Project } from "./projects";
import { measure } from "./draw";
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
  /** Permission requests people answered (ticked Yes or No) since the agent last looked. */
  approvals: unknown[];
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
  readonly approvals = this.doc.getMap<Approval>(DOC.approvals);

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
  /** Permission request id → the answer the agent was last told. */
  private reportedApprovals = new Map<string, Approval["answer"]>();

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
    for (const a of this.approvals.values()) this.reportedApprovals.set(a.id, a.answer);
    this.elements.observe((event, tr) => {
      this.scheduleRecompute();
      const touched = new Set<string>();
      for (const k of event.keysChanged) {
        const id = livingboardData(this.elements.get(k) ?? {})?.drawingId;
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
    this.migrateLegacyData();
  }

  /** Boards saved before the rename to Livingboard keep the agent's marks under `customData.sinapsi`. */
  private migrateLegacyData() {
    this.doc.transact(() => {
      for (const [id, el] of this.elements.entries()) {
        const data = (el as El & { customData?: Record<string, unknown> }).customData;
        if (!data || !("sinapsi" in data)) continue;
        const { sinapsi, ...rest } = data;
        this.elements.set(id, {
          ...el,
          customData: { ...rest, livingboard: rest.livingboard ?? sinapsi },
          version: el.version + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
        } as El);
      }
    }, SERVER);
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // A folder that can't be written (bad project path, permissions) must not take the server down.
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, Y.encodeStateAsUpdate(this.doc));
      } catch (err) {
        console.error(`[board:${this.name}] cannot save`, err);
      }
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
    // A tick in a permission box is an answer, not an idea to read.
    const marks = this.approvalMarkIds();
    const next = segment(
      [...this.elements.values()].filter((e) => !marks.has(e.id)),
      prev,
      now,
      explicit,
    );
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
              summary: "interpretation outdated: the node was split or merged",
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
    this.readApprovals();
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
      low: "LOW effort: only answer questions (@AI) and comments. Do not interpret or build anything else.",
      medium: "MEDIUM effort: interpret every ripe candidate and build what is clear.",
      high: "HIGH effort: interpret, build, and suggest ideas for obvious gaps with draw(ghost: true).",
    }[s.effort];
    const permission = {
      read: "READ-ONLY permissions: do not change files or external systems. Only interpret, comment, draw, attach_view.",
      ask: "ASK permissions: before building anything, ask with ask_permission and wait for the Yes in approvals.",
      auto: "AUTO permissions: take reversible actions (files under git) without asking; before irreversible ones (publishing, deleting, sending) ask with ask_permission and wait for the Yes.",
    }[s.permission];
    const mode = {
      hybrid: "HYBRID mode: your interpretations are proposals. Build a node only when feedback says the user confirmed it.",
      implicit: "IMPLICIT mode: your interpretations count right away. Show your assumptions so the user can correct you.",
    }[s.mode];
    const drawing =
      "Board = project: keep it in line with the project at all times, both ways. Draw what you build or decide (draw_svg for screens, objects, schemes; draw_table for comparisons, lists with attributes, statuses; draw_chart for numbers; extend for trees; draw_diagram for flows); when it changes, update it with replace: drawingId instead of adding copies; when it is outdated, delete it with erase. Changes people make to your drawings (drawingEdits) are instructions about the project. At most 20 words per element; the Document (write_doc) only for long text.";
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
          ? `Many strokes (${c.elementIds.length}): if it holds several ideas, look at it and split it with split_node.`
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
      approvals: [...this.approvals.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, 10)
        .map(({ id, question, drawingId, answer, about }) => ({ id, question, drawingId, answer, about })),
    };
  }

  // ---------------------------------------------------------------- permission requests

  addApproval(a: Approval) {
    this.doc.transact(() => this.approvals.set(a.id, a), SERVER);
    this.reportedApprovals.set(a.id, "pending");
  }

  /** People's marks in (or around) a box: small things whose centre lies on the box. */
  private marksIn(boxId: string, live: El[]): El[] {
    const box = this.elements.get(boxId);
    if (!box || box.isDeleted) return [];
    const b = elementBBox(box);
    const g = { x: b.x - b.w * 0.4, y: b.y - b.h * 0.4, w: b.w * 1.8, h: b.h * 1.8 };
    return live.filter((e) => {
      if (e.id === boxId || isAiAuthored(e)) return false;
      const m = elementBBox(e);
      if (m.w > b.w * 4 || m.h > b.h * 4) return false;
      const cx = m.x + m.w / 2;
      const cy = m.y + m.h / 2;
      return cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h;
    });
  }

  private approvalMarkIds(): Set<string> {
    const out = new Set<string>();
    if (!this.approvals.size) return out;
    const live = this.liveElements();
    for (const a of this.approvals.values()) for (const box of [a.yesBox, a.noBox]) for (const e of this.marksIn(box, live)) out.add(e.id);
    return out;
  }

  /** Turn settled ticks into answers (the latest mark wins); tint the chosen box. */
  private readApprovals() {
    if (!this.approvals.size) return;
    const live = this.liveElements();
    const now = Date.now();
    const latest = (els: El[]) => Math.max(0, ...els.map((e) => e.updated ?? 0));
    let changed = false;
    for (const a of this.approvals.values()) {
      if (this.elements.get(a.yesBox)?.isDeleted !== false) continue;
      const yes = this.marksIn(a.yesBox, live);
      const no = this.marksIn(a.noBox, live);
      // Still drawing: wait until the pen has been up for a moment.
      if ([...yes, ...no].some((e) => now - (e.updated ?? 0) < 700)) continue;
      const ty = latest(yes);
      const tn = latest(no);
      const answer: Approval["answer"] = !ty && !tn ? "pending" : ty >= tn ? "yes" : "no";
      if (answer === a.answer) continue;
      changed = true;
      this.doc.transact(() => {
        this.approvals.set(a.id, { ...a, answer, answeredAt: answer === "pending" ? undefined : now });
        const tint = (id: string, color: string) => {
          const el = this.elements.get(id) as (El & { backgroundColor?: string }) | undefined;
          if (el && el.backgroundColor !== color) {
            this.elements.set(id, { ...el, backgroundColor: color, fillStyle: "solid", version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now } as El);
          }
        };
        tint(a.yesBox, answer === "yes" ? "#b2f2bb" : "transparent");
        tint(a.noBox, answer === "no" ? "#ffc9c9" : "transparent");
      }, SERVER);
      if (answer !== "pending") this.log(`${answer === "yes" ? "Permission granted" : "Permission denied"}: ${a.question.slice(0, 60)}`, "info", a.nodeId);
    }
    if (changed) this.wake();
  }

  /** Answers the agent has not heard yet (a change of mind counts again). */
  private freshApprovals(consume: boolean) {
    const out = [...this.approvals.values()].filter((a) => a.answer !== "pending" && this.reportedApprovals.get(a.id) !== a.answer);
    if (consume) for (const a of out) this.reportedApprovals.set(a.id, a.answer);
    return out.map(({ id, question, drawingId, answer, about, nodeId }) => ({ id, question, drawingId, answer, about, nodeId }));
  }

  // ---------------------------------------------------------------- deleting text

  /**
   * What `refs` point at, as text to delete: a text element; the text inside a
   * shape; every text of a node or candidate (or its strokes, when it is
   * handwritten). Plus every typed text containing `match` (not the agent's
   * permission requests, which quote what they are about). `lenient` skips
   * refs that are gone instead of failing.
   */
  textTargets(refs: string[] = [], match?: string, lenient = false): El[] {
    const out = new Map<string, El>();
    const live = (id: string) => {
      const e = this.elements.get(id);
      return e && !e.isDeleted ? e : undefined;
    };
    for (const ref of refs) {
      const c = this.candidates.get(ref);
      if (c) {
        const els = c.elementIds.map(live).filter((e): e is El => !!e);
        const texts = els.filter((e) => e.type === "text");
        for (const e of texts.length ? texts : els.filter((e) => e.type === "freedraw")) out.set(e.id, e);
        continue;
      }
      const e = live(ref);
      if (!e && lenient) continue;
      if (!e) throw new Error(`${ref}: unknown element or node.`);
      if (e.type === "text" || e.type === "freedraw") out.set(e.id, e);
      else {
        const bound = ((e as El & { boundElements?: { id: string; type: string }[] | null }).boundElements ?? []).filter((x) => x.type === "text");
        if (!bound.length && lenient) continue;
        if (!bound.length) throw new Error(`${ref}: contains no text.`);
        for (const x of bound) {
          const t = live(x.id);
          if (t) out.set(t.id, t);
        }
      }
    }
    if (match?.trim()) {
      const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ");
      const needle = norm(match.trim());
      for (const e of this.liveElements()) {
        if (e.type !== "text" || livingboardData(e)?.kind === "permission") continue;
        if (norm(e.text ?? "").includes(needle)) out.set(e.id, e);
      }
    }
    return [...out.values()];
  }

  /**
   * Delete text, or only `part` of it. The agent's own text goes freely;
   * people's text only with a "yes" to a permission request covering it.
   */
  deleteText(input: { ids?: string[]; match?: string; part?: string; approvalId?: string }) {
    const targets = this.textTargets(input.ids, input.match);
    if (!targets.length) throw new Error("No text found: check ids or match (board_overview lists the candidates).");
    if (targets.length > 40) throw new Error(`Too many texts (${targets.length}): narrow ids or match.`);
    const human = targets.filter((e) => !isAiAuthored(e));
    if (human.length) {
      const a = input.approvalId ? this.approvals.get(input.approvalId) : undefined;
      const quote = human.map((e) => `"${(e.text ?? "hand stroke").slice(0, 40)}"`).join(", ");
      if (!a || a.answer !== "yes") {
        throw new Error(
          `A person's text (${quote}): first ask with ask_permission(about: [${human.map((e) => `"${e.id}"`).join(", ")}]) and pass its approvalId once they ticked Yes.` +
            (a ? ` Request ${a.id} ${a.answer === "no" ? "was declined" : "has no answer yet"}.` : ""),
        );
      }
      if (a.about?.length) {
        const allowed = new Set(this.textTargets(a.about, undefined, true).map((e) => e.id));
        const outside = human.filter((e) => !allowed.has(e.id));
        if (outside.length) throw new Error(`Permission ${a.id} does not cover: ${outside.map((e) => `"${(e.text ?? e.id).slice(0, 40)}"`).join(", ")}.`);
      }
    }
    if (input.part && targets.some((e) => e.type !== "text")) {
      throw new Error("part only works on typed text: handwritten text is deleted whole.");
    }
    const now = Date.now();
    const bump = (e: El, patch: Record<string, unknown>) =>
      ({ ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now }) as El;
    const deleted: string[] = [];
    const edited: { before: string; after: string }[] = [];
    const escaped = input.part ? input.part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
    this.doc.transact(() => {
      const remove = (e: El) => {
        this.elements.set(e.id, bump(e, { isDeleted: true }));
        deleted.push(e.text ?? "(hand stroke)");
        const container = e.containerId ? this.elements.get(e.containerId) : undefined;
        const refs = (container as (El & { boundElements?: { id: string }[] | null }) | undefined)?.boundElements;
        if (container && refs) this.elements.set(container.id, bump(container, { boundElements: refs.filter((r) => r.id !== e.id) }));
      };
      for (const e of targets) {
        if (!input.part) {
          remove(e);
          continue;
        }
        const before = e.text ?? "";
        const re = new RegExp(escaped, "gi");
        if (!re.test(before)) continue;
        const after = before
          .replace(re, "")
          .split("\n")
          .map((l) => l.replace(/[ \t]{2,}/g, " ").trim())
          .filter(Boolean)
          .join("\n");
        if (!after) {
          remove(e);
          continue;
        }
        const fontSize = Number((e as El & { fontSize?: number }).fontSize ?? 20);
        const m = measure(after, fontSize);
        this.elements.set(e.id, bump(e, { text: after, originalText: after, ...(e.containerId ? {} : { width: m.w, height: m.h }) }));
        edited.push({ before, after });
      }
    }, SERVER);
    if (input.part && !edited.length && !deleted.length) throw new Error(`"${input.part}" does not appear in the texts found.`);
    this.touchAgent("deleting text");
    this.log(`Deleted text: ${[...deleted, ...edited.map((x) => x.before)].map((t) => t.slice(0, 30)).join(", ")}`, "draw");
    return { deleted, edited };
  }

  // ---------------------------------------------------------------- agent drawings

  /** Agent drawings by id (live elements only, unless `withDeleted`). */
  private drawingGroups(withDeleted = false) {
    const out = new Map<string, El[]>();
    for (const e of this.elements.values()) {
      const id = livingboardData(e)?.drawingId;
      if (!id || (!withDeleted && e.isDeleted)) continue;
      const list = out.get(id) ?? [];
      list.push(e);
      out.set(id, list);
    }
    return out;
  }

  private describeDrawing(id: string, els: El[]): DrawingInfo {
    const meta = livingboardData(els[0]) ?? { author: "ai" as const };
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
    if (!els?.length) throw new Error(`${id}: unknown or already erased drawing (see drawings in board_overview).`);
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
    this.touchAgent("writing the Document");
    this.log(`${old ? "Updated" : "Wrote"} “${input.section}” in the Document`, "info");
    return id;
  }

  /** Compute a tidy tree layout and leave it as a proposal people can preview and apply. */
  proposeLayout(title: string, by: LayoutProposal["by"]) {
    const attached = new Map<string, ReturnType<typeof elementBBox>[]>();
    for (const e of this.liveElements()) {
      const owner = isAiAuthored(e) && e.type !== "arrow" ? livingboardData(e)?.nodeId : undefined;
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
        .filter((e) => isAiAuthored(e) && !linked.has(livingboardData(e)?.nodeId ?? ""))
        .map(elementBBox),
    ];
    const moves = treeLayout(nodes, edges, fixed);
    if (!moves.length) throw new Error("Nothing to tidy: it needs nodes linked by arrows, or it is already in order.");
    const p: LayoutProposal = { id: uid("lay_"), title, moves, by, at: Date.now() };
    this.doc.transact(() => this.proposal.set("current", p), SERVER);
    return p;
  }

  // ---------------------------------------------------------------- waiting

  async waitForChanges(timeoutMs: number, signal?: AbortSignal): Promise<ChangeReport> {
    this.listeningCount++;
    this.touchAgent("listening");
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
        approvals: [],
        idle: true,
        hint: "Nothing new. Call wait_for_changes again to keep listening.",
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
      approvals: this.freshApprovals(false).length,
      /** Changes since a given moment show up as a different signature. */
      sig: [...ready.map((c) => c.id + c.hash), this.feedback.length, ...this.removed.keys(), ...edited, ...this.freshApprovals(false).map((a) => a.id + a.answer)].join("|"),
    };
  }

  private collect(): ChangeReport | null {
    const ready = [...this.candidates.values()].filter((c) => c.state === "ready");
    const fb = this.feedback.slice(this.feedbackCursor);
    const drawingEdits = this.settledDrawingEdits();
    const approvals = this.freshApprovals(true);
    if (!ready.length && !fb.length && !this.removed.size && !this.settingsDirty && !drawingEdits.length && !approvals.length) return null;

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
      this.log(`Reading ${changes.length === 1 ? (changes[0] as { summary: string }).summary : `${changes.length} elements`}`, "read", first?.id);
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
      approvals,
      idle: false,
      hint: [
        approvals.length
          ? "approvals: a person answered one of your permission requests (yes/no). If yes, go ahead (to delete a person's text pass approvalId to delete_text); if no, don't. Then remove the request with erase(drawingId)."
          : "",
        needVision ? "Some candidates are sketches: look at them with get_board_image(nodeIds) before interpreting them." : "",
        drawingEdits.length
          ? "drawingEdits: a person changed or deleted your drawings (added/removed = changed texts). It is a change request for the project: adapt the project and the rest of the board to what you see now."
          : "",
        "Interpret with interpret(); then act per the policy; then call wait_for_changes again.",
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
          errors.push(`${n.id}: unknown candidate (deleted?)`);
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
        results.push(`${n.id} → ${type} “${n.label}” (${status})`);
      }

      for (const e of input.edges ?? []) {
        const link = e.id ? this.candidates.get(e.id) : undefined;
        const from = e.from ?? link?.from;
        const to = e.to ?? link?.to;
        if (!from || !to || !this.candidates.has(from) || !this.candidates.has(to)) {
          errors.push(`edge ${e.id ?? `${from}→${to}`}: unknown ends`);
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
      this.touchAgent(`reading “${first.label}”`, first.id);
      const n = input.nodes!.length;
      this.log(n === 1 ? `Read “${first.label}” as ${first.type}` : `Interpreted ${n} elements`, "interpret", first.id);
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
    if (!node) throw new Error(`Node ${nodeId} is not interpreted: call interpret() first.`);
    this.doc.transact(() => {
      this.nodes.set(nodeId, {
        ...node,
        build: { state, message, files: files ?? node.build?.files, at: Date.now() },
      });
    }, SERVER);
    this.glideTo(nodeId);
    const verb = { idle: "paused on", waiting: "waiting on", building: "building", done: "finished", error: "error on", question: "unsure about" }[state];
    this.touchAgent(`${verb} “${node.label}”`, nodeId);
    this.log(`${verb[0].toUpperCase()}${verb.slice(1)} “${node.label}”${message ? `: ${message}` : ""}`, "build", nodeId);
  }

  comment(input: { nodeId?: string; text: string; kind?: Comment["kind"]; replyTo?: string }) {
    if (input.nodeId && !this.candidates.has(input.nodeId)) throw new Error(`Unknown candidate ${input.nodeId}.`);
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
    this.touchAgent(c.kind === "question" ? "asking a question" : "commenting", c.nodeId);
    this.log(`${c.kind === "question" ? "Asked" : "Commented"}: ${c.text.slice(0, 80)}`, "comment", c.nodeId);
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
    if (!el || el.isDeleted || el.type !== "image") throw new Error(`${id}: not an image on the board.`);
    if (!isAiAuthored(el)) throw new Error(`${id}: this image belongs to a person, so it is not replaced. Add a new one.`);
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
    if (!this.nodes.has(input.nodeId)) throw new Error(`Node ${input.nodeId} is not interpreted: call interpret() first.`);
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
    this.touchAgent(`creating the view “${input.title}”`, input.nodeId);
    this.log(`Created the view “${input.title}”`, "view", input.nodeId);
    return id;
  }

  /**
   * Declare elements to be one idea. They leave any group they were in; groups
   * left with fewer than two elements disappear.
   */
  group(elementIds: string[], by: ExplicitGroup["by"]): string {
    const ids = [...new Set(elementIds)].filter((id) => this.elements.has(id));
    if (ids.length === 0) throw new Error("No elements to group.");
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
    if (k.projectId && !k.project) throw new Error(`Unknown project: ${k.projectId}`);
    b = new Board(key);
    boards.set(key, b);
  }
  return b;
}

/** Boards of a project currently open on the server. */
export function openBoardsOf(projectId: string): Board[] {
  return [...boards.values()].filter((b) => b.project?.id === projectId);
}
