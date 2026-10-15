import type { AINode, ViewDef } from "@sinapsi/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { saveView } from "./registry";

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

const BASE_CSS =
  "html,body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;color:#1f2328;background:#fff}*{box-sizing:border-box}";

const safeJson = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c");

/** The tiny API every AI-generated view gets: read props, listen, write back. */
function bridge(node: AINode) {
  return `<script>(function(){var ls=[];var s={node:${safeJson({ id: node.id, type: node.type, label: node.label })},props:${safeJson(node.props)},
onProps:function(fn){ls.push(fn);try{fn(s.props)}catch(e){console.error(e)}},
update:function(p){s.props=Object.assign({},s.props,p);parent.postMessage({__sinapsi:1,type:'update',patch:p},'*')},
resize:function(h){parent.postMessage({__sinapsi:1,type:'resize',height:h},'*')}};
window.sinapsi=s;window.addEventListener('message',function(e){var d=e.data;if(!d||!d.__sinapsi||d.type!=='props')return;s.node=d.node;s.props=d.props;ls.forEach(function(fn){try{fn(d.props)}catch(err){console.error(err)}})});
addEventListener('DOMContentLoaded',function(){var last=0;new ResizeObserver(function(){var h=Math.ceil(document.documentElement.scrollHeight);if(Math.abs(h-last)>2){last=h;s.resize(h)}}).observe(document.body)});})();</script>`;
}

function buildDoc(html: string, node: AINode) {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${BASE_CSS}</style>${bridge(node)}`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

interface Props {
  view: ViewDef;
  node: AINode;
  color: string;
  left: number;
  top: number;
  zoom: number;
  /** Where the card sits relative to its default spot (scene units): dragging adds to it. */
  offset: { dx: number; dy: number };
  onEdit: (patch: Record<string, unknown>) => void;
  onMove: (dx: number, dy: number) => void;
  onSaved: (name: string) => void;
  onPin: () => void;
  onClose: () => void;
  author: string;
}

/** Top-level props the view's code actually mentions: a good first guess for what it requires. */
function guessRequired(html: string, props: Record<string, unknown>) {
  return Object.keys(props).filter((k) => new RegExp(`\\b${k.replace(/[^\w]/g, "")}\\b`).test(html));
}

function SaveForm({ view, node, author, onDone, onCancel }: {
  view: ViewDef;
  node: AINode;
  author: string;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(view.title.replace(/\s*·.*$/, ""));
  const [description, setDescription] = useState(`Vista per nodi di tipo ${node.type}`);
  const [required, setRequired] = useState(guessRequired(view.html, node.props).join(", "));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="save-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const saved = await saveView({
            name: view.source,
            title,
            description,
            required: required.split(",").map((s) => s.trim()).filter(Boolean),
            types: [node.type],
            html: view.html,
            width: view.width,
            height: view.height,
            author,
          });
          onDone(saved.name);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <strong>{view.source ? "Aggiorna nel registro" : "Salva nel registro"}</strong>
      <label>
        Nome
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Quando usarla
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Props richieste <small className="muted">(separate da virgola)</small>
        <input value={required} onChange={(e) => setRequired(e.target.value)} placeholder="es. price.amount" />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="row">
        <button type="submit" className="btn ok" disabled={busy}>
          {busy ? "Salvo…" : "Salva"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Annulla
        </button>
      </div>
    </form>
  );
}

/**
 * An AI-generated mini app bound to one node. Sandboxed (scripts only, no
 * same-origin, no network via CSP); talks to us through postMessage only.
 */
export function ViewCard({ view, node, color, left, top, zoom, offset, onEdit, onMove, onSaved, onPin, onClose, author }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [saving, setSaving] = useState(false);
  const [height, setHeight] = useState(view.height);
  const [drag, setDrag] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  // Rebuild the document only when the agent ships new HTML; prop changes go through postMessage.
  const srcDoc = useMemo(() => buildDoc(view.html, node), [view.html, view.updatedAt]);

  useEffect(() => setHeight(view.height), [view.height]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { __sinapsi: 1, type: "props", props: node.props, node: { id: node.id, type: node.type, label: node.label } },
      "*",
    );
  }, [node.props, node.id, node.type, node.label]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { __sinapsi?: number; type?: string; patch?: Record<string, unknown>; height?: number };
      if (!d?.__sinapsi) return;
      if (d.type === "update" && d.patch && typeof d.patch === "object") onEdit(d.patch);
      if (d.type === "resize" && typeof d.height === "number") setHeight(Math.min(900, Math.max(80, d.height)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEdit]);

  // Drag by the header; the offset is stored in scene units so it follows pan/zoom and syncs to everyone.
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x: e.clientX, y: e.clientY, dx: 0, dy: 0 });
  };
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ ...drag, dx: (e.clientX - drag.x) / zoom, dy: (e.clientY - drag.y) / zoom });
  };
  const endDrag = () => {
    if (drag && (drag.dx || drag.dy)) onMove(offset.dx + drag.dx, offset.dy + drag.dy);
    setDrag(null);
  };

  return (
    <div
      className={`view-card ${drag ? "dragging" : ""}`}
      style={{
        left: left + (drag?.dx ?? 0) * zoom,
        top: top + (drag?.dy ?? 0) * zoom,
        width: view.width,
        transform: `scale(${zoom})`,
        borderColor: color,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="view-head"
        style={{ background: color }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Trascina per spostare"
      >
        <span>✳ {view.title}</span>
        <span className="view-actions">
          <button
            type="button"
            className={`save ${view.pinned ? "saved" : ""}`}
            onClick={onPin}
            title={view.pinned ? "Fissata: aperta per tutti. Tocca per aprirla solo su richiesta" : "Fissa: aperta per tutti"}
          >
            📌
          </button>
          <button
            type="button"
            className={`save ${view.source ? "saved" : ""}`}
            onClick={() => setSaving(!saving)}
            title={view.source ? `Nel registro come «${view.source}»: tocca per aggiornare` : "Salva nel registro per riusarla"}
          >
            {view.source ? "★" : "☆"}
          </button>
          <button type="button" onClick={onClose} title="Nascondi vista">
            ×
          </button>
        </span>
      </div>
      {saving && (
        <SaveForm
          view={view}
          node={node}
          author={author}
          onCancel={() => setSaving(false)}
          onDone={(name) => {
            setSaving(false);
            onSaved(name);
          }}
        />
      )}
      <iframe
        ref={frame}
        title={view.title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ height, pointerEvents: drag ? "none" : undefined }}
      />
    </div>
  );
}
