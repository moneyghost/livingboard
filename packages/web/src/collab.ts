import { CaptureUpdateAction, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  SocketId,
} from "@excalidraw/excalidraw/types";
import { AI_COLOR, type BoardFile, DOC, MAX_IMAGE_BYTES, sinapsiData } from "@sinapsi/shared";
import { generateKeyBetween } from "fractional-indexing";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { Identity } from "./identity";

const LOCAL = "local";

export const SERVER_HOST = import.meta.env.DEV ? `${location.hostname}:3333` : location.host;
const WS = location.protocol === "https:" ? "wss" : "ws";

type El = ExcalidrawElement;

function byIndex(a: El, b: El) {
  const ai = a.index ?? "";
  const bi = b.index ?? "";
  if (ai === bi) return a.id < b.id ? -1 : 1;
  if (!ai) return 1;
  if (!bi) return -1;
  return ai < bi ? -1 : 1;
}

const isAi = (el: El) => !!sinapsiData(el as { customData?: Record<string, unknown> });

const indexOk = new Map<string, boolean>();
/**
 * One malformed fractional index (from a buggy client or a hand-edited doc)
 * makes Excalidraw's index repair throw and the whole board fail to load.
 * Drop bad indices so Excalidraw regenerates them instead.
 */
function sane(el: El): El {
  const idx = el.index;
  if (!idx) return el;
  let ok = indexOk.get(idx);
  if (ok === undefined) {
    try {
      generateKeyBetween(idx, null);
      ok = true;
    } catch {
      ok = false;
    }
    indexOk.set(idx, ok);
  }
  return ok ? el : ({ ...el, index: null } as unknown as El);
}

/**
 * Binds an Excalidraw instance to a Y.Doc: elements live in a Y.Map keyed by
 * id and the newest `version` wins (Excalidraw's own reconciliation rule).
 * Presence (cursors, selection, typing) goes through Yjs awareness, and so
 * does the AI's cursor, which the server drives.
 */
export class Collab {
  readonly doc = new Y.Doc();
  readonly provider: WebsocketProvider;
  readonly elements: Y.Map<El>;
  /** Image data, keyed by fileId: elements only carry the id. */
  readonly files: Y.Map<BoardFile>;
  private api: ExcalidrawImperativeAPI | null = null;
  private known = new Map<string, number>();
  private synced = false;
  private lastSelected = "";
  private lastEditing = "";
  onCollaborators?: (map: Map<SocketId, Collaborator>) => void;
  onSynced?: () => void;
  /**
   * Excalidraw resets its scene to `initialData` once mounted, wiping anything
   * pushed earlier: hand it the board after the first sync instead (or an empty
   * board if the server is unreachable).
   */
  readonly initialData: Promise<ExcalidrawInitialDataState | null>;
  private resolveInitial!: (data: ExcalidrawInitialDataState | null) => void;

  constructor(
    readonly board: string,
    readonly me: Identity,
  ) {
    this.initialData = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      this.resolveInitial = (data) => {
        clearTimeout(timer);
        resolve(data);
      };
    });
    this.provider = new WebsocketProvider(`${WS}://${SERVER_HOST}/yjs`, encodeURIComponent(board), this.doc);
    this.elements = this.doc.getMap<El>(DOC.elements);
    this.files = this.doc.getMap<BoardFile>(DOC.files);
    this.provider.awareness.setLocalStateField("user", { name: me.name, color: me.color });

    this.provider.on("sync", (isSynced: boolean) => {
      if (!isSynced || this.synced) return;
      this.synced = true;
      const remote = [...this.elements.values()].map(sane);
      const elements = [
        ...restoreElements(remote.filter((e) => !isAi(e)), null, { repairBindings: true }),
        ...restoreElements(remote.filter(isAi), null, { refreshDimensions: true, repairBindings: true }),
      ].sort(byIndex);
      for (const el of elements) this.known.set(el.id, el.version);
      const files = Object.fromEntries([...this.files.values()].map((f) => [f.id, f])) as unknown as BinaryFiles;
      this.resolveInitial({ elements, files, scrollToContent: true });
      // Updates that land while Excalidraw is still initializing: re-apply once it's settled.
      setTimeout(() => this.applyRemote([...this.elements.keys()]), 300);
      this.onSynced?.();
    });

    this.elements.observe((event, tr) => {
      if (tr.origin === LOCAL) return;
      this.applyRemote([...event.keysChanged]);
    });
    this.files.observe((event, tr) => {
      if (tr.origin === LOCAL) return;
      this.applyFiles([...event.keysChanged]);
    });

    // Our own presence changes are emitted from inside Excalidraw's callbacks: only react to
    // remote peers, and defer so we never update Excalidraw while it is rendering.
    this.provider.awareness.on("change", (_: unknown, origin: unknown) => {
      if (origin === "local") return;
      queueMicrotask(() => this.emitCollaborators());
    });
  }

  get isSynced() {
    return this.synced;
  }

  attach(api: ExcalidrawImperativeAPI) {
    this.api = api;
    if (this.synced) {
      this.applyRemote([...this.elements.keys()]);
      this.applyFiles([...this.files.keys()]);
    }
  }

  /**
   * Excalidraw → Y: share images pasted or inserted here (each file once, never rewritten).
   * Only files a live image uses: Excalidraw keeps old ones in memory, and the
   * server drops a file when the agent swaps the picture.
   */
  pushFiles(elements: readonly El[], files: BinaryFiles) {
    if (!this.synced) return;
    const used = new Set<string>();
    for (const el of elements) if (el.type === "image" && !el.isDeleted && el.fileId) used.add(el.fileId);
    const fresh = [...used].map((id) => files[id]).filter((f) => f?.dataURL && !this.files.has(f.id));
    if (!fresh.length) return;
    this.doc.transact(() => {
      for (const f of fresh) {
        // base64 is 4/3 of the bytes: past the cap the board would get heavy for everyone.
        if (f.dataURL.length * 0.75 > MAX_IMAGE_BYTES) {
          console.warn(`Sinapsi: immagine ${f.id} troppo grande per la condivisione`);
          continue;
        }
        this.files.set(f.id, { id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created });
      }
    }, LOCAL);
  }

  /** Y → Excalidraw: hand over images that arrived from others (or from the agent). */
  private applyFiles(keys: string[]) {
    if (!this.api || !keys.length) return;
    const have = this.api.getFiles();
    const add = keys.map((k) => this.files.get(k)).filter((f): f is BoardFile => !!f && !have[f.id]);
    if (add.length) this.api.addFiles(add as unknown as BinaryFileData[]);
  }

  /** Excalidraw → Y: push every element whose version moved. */
  pushLocal(elements: readonly El[]) {
    if (!this.synced) return;
    const changed = elements.filter((el) => this.known.get(el.id) !== el.version);
    if (!changed.length) return;
    this.doc.transact(() => {
      for (const el of changed) {
        const remote = this.elements.get(el.id);
        if (remote && remote.version > el.version) continue;
        this.elements.set(el.id, structuredClone(el) as El);
        this.known.set(el.id, el.version);
      }
    }, LOCAL);
  }

  /** Y → Excalidraw: merge remote elements that are newer than ours. */
  private applyRemote(keys: string[]) {
    if (!this.api || !keys.length) return;
    const local = this.api.getSceneElementsIncludingDeleted();
    const map = new Map<string, El>(local.map((e) => [e.id, e]));
    const human: El[] = [];
    const ai: El[] = [];
    for (const key of keys) {
      const stored = this.elements.get(key);
      if (!stored) continue;
      const remote = sane(stored);
      const mine = map.get(key);
      if (mine && (mine.version > remote.version || (mine.version === remote.version && mine.versionNonce === remote.versionNonce))) {
        this.known.set(key, mine.version);
        continue;
      }
      (isAi(remote) ? ai : human).push(remote);
    }
    if (!human.length && !ai.length) return;
    // AI elements are generated server-side with estimated text metrics: let Excalidraw re-measure them.
    const restored = [
      ...restoreElements(human, null, { repairBindings: true }),
      ...restoreElements(ai, null, { refreshDimensions: true, repairBindings: true }),
    ];
    for (const el of restored) {
      map.set(el.id, el);
      this.known.set(el.id, el.version);
    }
    this.api.updateScene({ elements: [...map.values()].sort(byIndex), captureUpdate: CaptureUpdateAction.NEVER });
  }

  // ------------------------------------------------------------- presence

  pointer(x: number, y: number, tool: "pointer" | "laser", button: "up" | "down") {
    this.provider.awareness.setLocalStateField("pointer", { x, y, tool });
    this.provider.awareness.setLocalStateField("button", button);
  }

  presence(appState: AppState) {
    const selected = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]);
    const sel = selected.join(",");
    if (sel !== this.lastSelected) {
      this.lastSelected = sel;
      this.provider.awareness.setLocalStateField("selected", selected);
    }
    const t = appState.editingTextElement;
    const editing = t ? [t.id, ...("containerId" in t && t.containerId ? [t.containerId] : [])] : [];
    const ed = editing.join(",");
    if (ed !== this.lastEditing) {
      this.lastEditing = ed;
      this.provider.awareness.setLocalStateField("editing", editing);
    }
  }

  private emitCollaborators() {
    const out = new Map<SocketId, Collaborator>();
    const myId = this.doc.clientID;
    for (const [clientId, state] of this.provider.awareness.getStates()) {
      if (clientId === myId || !state?.user) continue;
      const user = state.user as { name: string; color: string; ai?: boolean };
      const activity = state.activity as string | undefined;
      const selected = (state.selected as string[] | undefined) ?? [];
      // Excalidraw derives cursor colors from a hash of `id`: "claude-52" lands on an orange hue.
      out.set(String(clientId) as SocketId, {
        id: user.ai ? "claude-52" : String(clientId),
        socketId: String(clientId) as SocketId,
        username: user.ai ? (activity ? `✳ Claude · ${activity}` : "✳ Claude") : user.name,
        color: { background: user.ai ? AI_COLOR : user.color, stroke: user.ai ? AI_COLOR : user.color },
        pointer: state.pointer
          ? { ...(state.pointer as NonNullable<Collaborator["pointer"]>), ...(user.ai ? { laserColor: AI_COLOR } : {}) }
          : undefined,
        button: (state.button as "up" | "down" | undefined) ?? "up",
        selectedElementIds: Object.fromEntries(selected.map((id) => [id, true])),
      });
    }
    this.onCollaborators?.(out);
  }

  destroy() {
    this.provider.destroy();
    this.doc.destroy();
  }
}

