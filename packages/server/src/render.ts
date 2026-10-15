import type { WebSocket } from "ws";

/**
 * The server cannot rasterize Excalidraw by itself (it needs a DOM and the
 * real fonts), so it borrows an open browser tab: every tab registers on
 * /rpc/<board> and the most recent one renders PNGs on request.
 */

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RenderResult {
  data: string; // base64 PNG
  width: number;
  height: number;
  /** Scene coordinates of the image's top-left pixel, and pixels per scene unit. */
  originX: number;
  originY: number;
  scale: number;
}

const renderers = new Map<string, WebSocket[]>();
const pending = new Map<string, Pending>();
let seq = 0;

export function registerRenderer(board: string, ws: WebSocket) {
  const list = renderers.get(board) ?? [];
  list.push(ws);
  renderers.set(board, list);
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error ?? "render failed"));
    } catch {
      // ignore malformed messages
    }
  });
  ws.on("close", () => {
    renderers.set(
      board,
      (renderers.get(board) ?? []).filter((w) => w !== ws),
    );
  });
}

export function hasRenderer(board: string): boolean {
  return (renderers.get(board) ?? []).some((w) => w.readyState === w.OPEN);
}

/** Ask the most recent browser tab of a board to do something only a DOM can do. */
export function rpcCall<T>(board: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const open = (renderers.get(board) ?? []).filter((w) => w.readyState === w.OPEN);
  const ws = open[open.length - 1];
  if (!ws) {
    return Promise.reject(new Error("Nessun browser ha la lavagna aperta: apri la lavagna nel browser e riprova."));
  }
  const id = `r${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Il browser non ha risposto in tempo."));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

export function renderPng(
  board: string,
  elementIds: string[] | null,
  opts: { padding: number; maxSize: number },
): Promise<RenderResult> {
  return rpcCall<RenderResult>(board, { type: "export", elementIds, ...opts });
}
