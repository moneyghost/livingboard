/**
 * Shared contract between the board server, the web client and the agent.
 *
 * One Y.Doc per board. Every top-level key below is a Y.Map / Y.Array whose
 * values are plain JSON objects (replaced whole on update, never mutated).
 */

export const DOC = {
  /** Excalidraw elements, keyed by element id. Written by browsers (and the server for AI drawings). */
  elements: "elements",
  /** Geometric pre-pass output (server only): clusters of elements that probably mean one thing. */
  candidates: "candidates",
  /** The AI's reading of the board: typed semantic nodes. */
  nodes: "nodes",
  /** Typed relations between nodes. */
  edges: "edges",
  /** Emergent ontology: types the AI invented while reading this board. */
  ontology: "ontology",
  comments: "comments",
  /** Interactive views attached to nodes (sandboxed HTML). */
  views: "views",
  settings: "settings",
  /** Agent presence/status (server only). */
  agent: "agent",
  /** User feedback the agent must see (confirmations, corrections, replies...). */
  feedback: "feedback",
  /** Human-readable log of what the agent did. */
  activity: "activity",
  /** Explicit groups: elements a human or the agent declared to be one idea. */
  groups: "groups",
  /** The board's document: summaries and lists live here, not on the canvas. */
  doc: "doc",
  /** A pending "tidy up" proposal (previewed as ghosts until someone applies it). */
  proposal: "proposal",
  /** Image data for Excalidraw image elements, keyed by fileId (Excalidraw's BinaryFileData). */
  files: "files",
  /** Permission requests the agent drew (a question with Sì/No boxes people tick). */
  approvals: "approvals",
} as const;

/**
 * A permission the agent asked for on the board: a drawn question with two
 * boxes. Whatever a person marks inside a box (a pen tick, an x, a ✓) answers it.
 */
export interface Approval {
  id: string;
  question: string;
  /** The agent drawing (question + boxes): erase it once done. */
  drawingId: string;
  /** Element ids of the two boxes: they are read where they are now, even if people moved the drawing. */
  yesBox: string;
  noBox: string;
  /** What the request is about (elements or nodes), e.g. text the agent wants to delete. */
  about?: string[];
  nodeId?: string;
  answer: "pending" | "yes" | "no";
  at: number;
  answeredAt?: number;
}

/** Same shape as Excalidraw's BinaryFileData, so browsers can hand it straight to `addFiles`. */
export interface BoardFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

/** Largest image (decoded bytes) that goes into a board: every client downloads all of them. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export type BBox = { x: number; y: number; w: number; h: number };

export type CandidateKind =
  | "shape"
  | "sketch"
  | "text"
  | "question"
  | "frame"
  | "image"
  | "link";

/**
 * Attention state, drawn by the client:
 * - quiet: the agent will not look at it (effort "low" and not a question)
 * - maturing: someone is still working on it, waiting for it to settle
 * - ready: settled, queued for the agent
 * - read: the agent has seen this exact version
 */
export type AttentionState = "quiet" | "maturing" | "ready" | "read";

export interface Candidate {
  id: string;
  kind: CandidateKind;
  elementIds: string[];
  bbox: BBox;
  texts: string[];
  summary: string;
  /** Smallest candidate (shape or frame) that contains this one. */
  parentId?: string;
  /** For links: the candidates the arrow connects. */
  from?: string;
  to?: string;
  hash: string;
  changedAt: number;
  state: AttentionState;
  /** When the candidate will be considered mature (ms epoch), for the client's ring animation. */
  matureAt?: number;
  needsVision: boolean;
}

export type NodeStatus = "proposed" | "confirmed" | "rejected";
export type BuildState = "idle" | "waiting" | "building" | "done" | "error" | "question";

export interface BuildInfo {
  state: BuildState;
  message?: string;
  files?: string[];
  at: number;
}

export interface AINode {
  /** Same id as the candidate it reads. */
  id: string;
  elementIds: string[];
  type: string;
  label: string;
  /** One-line reading of what the user meant. */
  summary?: string;
  props: Record<string, unknown>;
  confidence: number;
  status: NodeStatus;
  by: "ai" | "user";
  assumptions: string[];
  build?: BuildInfo;
  /** Candidate hash at interpretation time: if it differs now, the reading is stale. */
  hash: string;
  updatedAt: number;
}

export interface AIEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  label?: string;
  status: NodeStatus;
  by: "ai" | "user";
  confidence: number;
  updatedAt: number;
}

export interface OntologyType {
  name: string;
  description: string;
  color: string;
  icon: string;
  fields?: Record<string, string>;
}

export interface Comment {
  id: string;
  nodeId?: string;
  author: "ai" | "user";
  authorName: string;
  kind: "answer" | "question" | "note" | "reply";
  text: string;
  replyTo?: string;
  at: number;
}

/**
 * "These elements are one idea." Overrides the geometric pre-pass: members are
 * always clustered together and two groups never merge. An element belongs to
 * at most one group.
 */
export interface ExplicitGroup {
  id: string;
  elementIds: string[];
  by: "ai" | "user";
  at: number;
}

/** A section of the board's document, written by the agent (or a person). */
export interface DocSection {
  id: string;
  title: string;
  markdown: string;
  nodeIds?: string[];
  by: "ai" | "user";
  order: number;
  updatedAt: number;
}

/** "Move these nodes like this": shown as ghosts, applied by a human. */
export interface LayoutProposal {
  id: string;
  title: string;
  moves: { nodeId: string; dx: number; dy: number }[];
  by: "ai" | "user";
  at: number;
}

/** How the people on this board draw, so the agent can draw the same way. */
export interface BoardStyle {
  /** Most used ink color in human drawings. */
  ink: string;
  /** Whether people mostly write by hand (freedraw) or type. */
  handwriting: boolean;
  /** Typical size of writing, in scene units (letter height). */
  textSize: number;
  /** Nodes drawn as boxes/shapes or as bare words. */
  nodes: "boxes" | "words";
  /** Relations drawn as hand strokes or as Excalidraw arrows. */
  arrows: "hand" | "arrows" | "none";
}

export interface ViewDef {
  id: string;
  nodeId: string;
  title: string;
  html: string;
  width: number;
  height: number;
  /** Offset (scene units) from the default spot next to the node, set by dragging. */
  dx?: number;
  dy?: number;
  /** Name of the saved view (registry) this one was applied from. */
  source?: string;
  /** Open for everyone. Otherwise a view only opens when someone asks for it. */
  pinned?: boolean;
  updatedAt: number;
}

/**
 * A view saved to the registry: reusable on any node of any board whose props
 * have the right shape. Matching is by data, not by type name, because types
 * are invented by the AI and differ between boards.
 */
export interface SavedView {
  name: string;
  title: string;
  description: string;
  /** Prop paths the node must have, e.g. ["price.amount"]. */
  required: string[];
  /** Types it was made for: only a ranking hint. */
  types: string[];
  html: string;
  width: number;
  height: number;
  author: string;
  createdAt: number;
  updatedAt: number;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function viewMatches(view: Pick<SavedView, "required">, props: Record<string, unknown>): boolean {
  return view.required.every((p) => getPath(props, p) !== undefined);
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "vista"
  );
}

export type Mode = "hybrid" | "implicit";
export type Effort = "low" | "medium" | "high";
export type Permission = "read" | "ask" | "auto";

export interface Settings {
  mode: Mode;
  effort: Effort;
  permission: Permission;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "implicit",
  effort: "medium",
  permission: "auto",
};

/** How long a candidate must stay untouched before the agent reads it. */
export const STABILITY_MS: Record<Effort, number> = {
  low: 4000,
  medium: 4000,
  high: 2000,
};

export type FeedbackKind =
  | "confirm"
  | "reject"
  | "retype"
  | "reply"
  | "view-edit"
  | "accept-ghost"
  | "reject-ghost"
  | "view-apply"
  | "layout-accept"
  | "layout-reject";

export interface Feedback {
  id: string;
  at: number;
  kind: FeedbackKind;
  user: string;
  nodeId?: string;
  edgeId?: string;
  commentId?: string;
  data?: unknown;
}

export interface AgentState {
  listening: boolean;
  lastSeen: number;
  activity?: string;
  nodeId?: string;
}

export interface Activity {
  id: string;
  at: number;
  text: string;
  nodeId?: string;
  kind: "read" | "interpret" | "build" | "comment" | "draw" | "view" | "info";
}

/** Marker stored in Excalidraw `customData` on elements the AI drew. */
export interface SinapsiElementData {
  author: "ai" | "ai-accepted";
  ghost?: boolean;
  ghostGroup?: string;
  /** The node this drawing belongs to (an annotation, a note, an extension): it moves with it. */
  nodeId?: string;
  /** One agent drawing = every element one tool call made: the unit the agent updates or erases. */
  drawingId?: string;
  /** What the drawing is (svg, table, chart, note, image...) and its title: how the agent finds it again. */
  kind?: string;
  title?: string;
}

export function sinapsiData(el: { customData?: Record<string, unknown> }): SinapsiElementData | undefined {
  return el.customData?.sinapsi as SinapsiElementData | undefined;
}

/** True for elements the agent should not react to (its own drawings, unless accepted). */
export function isAiAuthored(el: { customData?: Record<string, unknown> }): boolean {
  return sinapsiData(el)?.author === "ai";
}

export const AI_COLOR = "#d97757";

export function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export * from "./layout";
