import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const PING_INTERVAL = 30_000;

/**
 * Minimal y-websocket compatible room: keeps one Y.Doc + Awareness in sync with
 * every browser connected to it. The server itself is also a peer (it writes
 * candidates, AI nodes and the AI cursor), so updates are broadcast regardless
 * of origin.
 */
export class YRoom {
  readonly conns = new Map<WebSocket, Set<number>>();

  constructor(
    readonly doc: Y.Doc,
    readonly awareness: awarenessProtocol.Awareness,
  ) {
    doc.on("update", (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    });

    awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        const controlled = this.conns.get(origin as WebSocket);
        if (controlled) {
          for (const id of added) controlled.add(id);
          for (const id of removed) controlled.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  private broadcast(message: Uint8Array) {
    for (const ws of this.conns.keys()) send(ws, message);
  }

  connect(ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    this.conns.set(ws, new Set());

    ws.on("message", (data: ArrayBuffer | Buffer) => {
      try {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
        const decoder = decoding.createDecoder(bytes);
        const encoder = encoding.createEncoder();
        const type = decoding.readVarUint(decoder);
        if (type === MESSAGE_SYNC) {
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
          if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
        } else if (type === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
        }
      } catch (err) {
        console.error("[yjs] bad message", err);
      }
    });

    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_INTERVAL);

    ws.on("close", () => {
      clearInterval(ping);
      const controlled = this.conns.get(ws);
      this.conns.delete(ws);
      if (controlled?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...controlled], null);
    });

    // Handshake: our state vector, then everyone's presence.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    send(ws, encoding.toUint8Array(encoder));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      send(ws, encoding.toUint8Array(aw));
    }
  }
}

function send(ws: WebSocket, message: Uint8Array) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(message, (err) => {
    if (err) ws.close();
  });
}
