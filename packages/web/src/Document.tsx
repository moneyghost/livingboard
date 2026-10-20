import type { AIEdge, AINode, DocSection, OntologyType } from "@livingboard/shared";
import { type ReactNode, useMemo, useState } from "react";
import type { BoardModel } from "./board";
import { useYMap } from "./hooks";

/** **bold**, `code` and *italic*: enough for notes, no HTML ever injected. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\*[^*]+\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    para = [];
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
      blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    }
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const Tag = (["h4", "h5", "h6"] as const)[h[1].length - 1];
      blocks.push(<Tag key={blocks.length}>{inline(h[2])}</Tag>);
    } else if (bullet || num) {
      if (para.length || (list && list.ordered !== !!num)) flush();
      list ??= { ordered: !!num, items: [] };
      list.items.push((bullet ?? num)![1]);
    } else if (!line.trim()) flush();
    else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className="md">{blocks}</div>;
}

const fmt = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v));

function toMarkdown(sections: DocSection[], groups: [string, AINode[]][], edgesFrom: (id: string) => string[]) {
  const out: string[] = [];
  for (const s of sections) out.push(`## ${s.title}`, "", s.markdown, "");
  if (groups.length) out.push("## Board map", "");
  for (const [type, list] of groups) {
    out.push(`### ${type}`, "");
    for (const n of list) {
      out.push(`- **${n.label}**${n.summary ? ` — ${n.summary}` : ""}`);
      const props = Object.entries(n.props);
      if (props.length) out.push(`  - ${props.map(([k, v]) => `${k}: ${fmt(v)}`).join(" · ")}`);
      for (const rel of edgesFrom(n.id)) out.push(`  - ${rel}`);
      for (const a of n.assumptions) out.push(`  - ⚠ ${a}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * Where summaries and lists live, so the canvas can stay a drawing: sections the
 * agent writes (write_doc) plus a map generated from the semantic graph.
 */
export function DocumentView({ model, onFocus }: { model: BoardModel; onFocus: (nodeId: string) => void }) {
  const sectionsMap = useYMap(model.docSections);
  const nodesMap = useYMap(model.nodes);
  const edgesMap = useYMap(model.edges);
  const ontology = useYMap(model.ontology);
  const [copied, setCopied] = useState(false);

  const sections = [...sectionsMap.values()].sort((a, b) => a.order - b.order);
  const nodes = [...nodesMap.values()].filter((n) => n.status !== "rejected");
  const typeOrder = [...ontology.keys()];
  const groups = useMemo(() => {
    const byType = new Map<string, AINode[]>();
    for (const n of nodes) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
    return [...byType.entries()].sort((a, b) => {
      const ia = typeOrder.indexOf(a[0]);
      const ib = typeOrder.indexOf(b[0]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }, [nodes, typeOrder]);

  const edgesFrom = (id: string) =>
    [...edgesMap.values()]
      .filter((e: AIEdge) => e.from === id && e.status !== "rejected")
      .map((e) => `→ ${e.type} ${nodesMap.get(e.to)?.label ?? "?"}${e.label ? ` (${e.label})` : ""}`);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(sections, groups, edgesFrom));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked
    }
  };

  const typeInfo = (t: string): OntologyType | undefined => ontology.get(t);

  return (
    <div className="doc">
      <div className="doc-actions">
        <button type="button" className="btn" onClick={copy}>
          {copied ? "✓ Copied" : "Copy Markdown"}
        </button>
      </div>

      {sections.length === 0 ? (
        <p className="muted small">
          Claude writes summaries, lists and cards here, so the board stays made of drawings.
        </p>
      ) : (
        sections.map((s) => (
          <section key={s.id} className="doc-section">
            <h3>{s.title}</h3>
            <Markdown text={s.markdown} />
            {s.nodeIds?.length ? (
              <div className="doc-links">
                {s.nodeIds
                  .filter((id) => nodesMap.has(id))
                  .map((id) => (
                    <button key={id} type="button" className="link-btn" onClick={() => onFocus(id)}>
                      ◎ {nodesMap.get(id)!.label}
                    </button>
                  ))}
              </div>
            ) : null}
          </section>
        ))
      )}

      {groups.length > 0 && (
        <section className="doc-section">
          <h3>Board map</h3>
          {groups.map(([type, list]) => (
            <div key={type} className="doc-type">
              <h4>
                <span className="type-dot" style={{ background: typeInfo(type)?.color ?? "#868e96" }}>
                  {typeInfo(type)?.icon ?? "◆"}
                </span>
                {type} <span className="muted small">{list.length}</span>
              </h4>
              <ul>
                {list.map((n) => (
                  <li key={n.id}>
                    <button type="button" className="link-btn" onClick={() => onFocus(n.id)}>
                      {n.label}
                    </button>
                    {n.summary && <span className="muted"> — {n.summary}</span>}
                    {Object.keys(n.props).length > 0 && (
                      <div className="doc-props">
                        {Object.entries(n.props).map(([k, val]) => (
                          <span key={k}>
                            {k}: <b>{fmt(val)}</b>
                          </span>
                        ))}
                      </div>
                    )}
                    {edgesFrom(n.id).map((rel) => (
                      <div key={rel} className="doc-rel small">
                        {rel}
                      </div>
                    ))}
                    {n.build?.state === "done" && n.build.files?.length ? (
                      <div className="doc-rel small">✓ {n.build.files.length} {n.build.files.length === 1 ? "file" : "files"}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
