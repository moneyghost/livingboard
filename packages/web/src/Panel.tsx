import { type AgentState, type AINode, type Comment, DEFAULT_SETTINGS, type Settings } from "@livingboard/shared";
import { useState } from "react";
import type { BoardModel } from "./board";
import { SERVER_HOST } from "./collab";
import { useNow, useYArray, useYMap } from "./hooks";
import { DocumentView } from "./Document";
import { deleteView, useSavedViews } from "./registry";
import type { Identity } from "./identity";

interface Props {
  model: BoardModel;
  board: string;
  /** Folder name of the project the board belongs to (null: a global board). */
  project: string | null;
  me: Identity;
  lens: boolean;
  onLens: (v: boolean) => void;
  showBoxes: boolean;
  onShowBoxes: (v: boolean) => void;
  onExample: () => void;
  onFocus: (nodeId: string) => void;
  tablet: boolean;
  onTablet: (v: boolean) => void;
}

function ago(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

function Segmented<T extends string>(props: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {props.options.map(([val, label]) => (
        <button
          key={val}
          type="button"
          role="radio"
          aria-checked={props.value === val}
          className={props.value === val ? "on" : ""}
          onClick={() => props.onChange(val)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } catch {
            // clipboard blocked: the text is still selectable
          }
        }}
      >
        {done ? "✓" : "Copy"}
      </button>
    </div>
  );
}

const HINTS = {
  mode: {
    hybrid: "Claude proposes how it reads each thing; it builds only what you confirm.",
    implicit: "Claude interprets and acts right away; you correct it when it gets it wrong.",
  },
  effort: {
    low: "Only answers @AI questions.",
    medium: "Reads everything that settles and builds what is clear.",
    high: "More proactive: builds and proposes ghost ideas.",
  },
  permission: {
    read: "No files or external systems.",
    ask: "Asks on the board before building.",
    auto: "Reversible actions right away; asks before irreversible ones.",
  },
} as const;

export function Panel({ model, board, project, me, lens, onLens, showBoxes, onShowBoxes, onExample, onFocus, tablet, onTablet }: Props) {
  const settingsMap = useYMap(model.settings);
  const agentMap = useYMap(model.agent);
  const ontology = useYMap(model.ontology);
  const nodes = useYMap(model.nodes);
  const comments = useYMap(model.comments);
  const candidates = useYMap(model.candidates);
  const savedViews = useSavedViews();
  const activity = useYArray(model.activity);
  const now = useNow(1000);
  // On a tablet the canvas comes first: the panel starts closed and opens over it.
  const [collapsed, setCollapsed] = useState(tablet);
  const [tab, setTab] = useState<"board" | "doc">("board");
  const [tidyMsg, setTidyMsg] = useState("");
  const proposal = useYMap(model.proposal);
  const docCount = useYMap(model.docSections).size;

  const s: Settings = { ...DEFAULT_SETTINGS, ...(Object.fromEntries(settingsMap) as Partial<Settings>) };
  const agent = agentMap.get("state") as AgentState | undefined;
  const since = agent?.lastSeen ? now - agent.lastSeen : Infinity;
  const status =
    agent?.listening && since < 60_000
      ? { cls: "listening", text: "Claude is listening" }
      : since < 20_000
        ? { cls: "working", text: "Claude is working" }
        : since < 120_000
          ? { cls: "idle", text: "Claude connected" }
          : { cls: "off", text: "Claude not connected" };

  const queued = [...candidates.values()].filter((c) => c.state === "ready").length;
  const counts = new Map<string, number>();
  for (const n of nodes.values() as Iterable<AINode>) if (n.status !== "rejected") counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const boardComments = [...(comments.values() as Iterable<Comment>)].filter((c) => !c.nodeId).sort((a, b) => b.at - a.at);
  const mcpUrl = `${location.protocol}//${SERVER_HOST}/mcp`.replace("127.0.0.1", "localhost");

  if (collapsed) {
    return (
      <button type="button" className="panel-tab" onClick={() => setCollapsed(false)} title="Open the Livingboard panel">
        <span className={`status-dot ${status.cls}`} />✳
      </button>
    );
  }

  return (
    <aside className={`panel ${tab === "doc" ? "wide" : ""}`}>
      <header className="panel-head">
        <div>
          <h1>✳ Livingboard</h1>
          <span className="muted small">
            {project && (
              <>
                <b>{project}</b> ·{" "}
              </>
            )}
            board <b>{board}</b> · you are <b style={{ color: me.color }}>{me.name}</b>
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={() => setCollapsed(true)} title="Close panel">
          ⟩
        </button>
      </header>

      <section className={`agent-card ${status.cls}`}>
        <div className="agent-line">
          <span className={`status-dot ${status.cls}`} />
          <strong>{status.text}</strong>
          {agent?.lastSeen ? <span className="muted small">{ago(since)}</span> : null}
        </div>
        {agent?.activity && since < 30_000 && <p className="small">{agent.activity}</p>}
        {queued > 0 && (
          <p className="small muted">
            {queued === 1 ? "1 item" : `${queued} items`} to read
          </p>
        )}
        {status.cls === "off" && (
          <div className="connect">
            {project ? (
              <>
                <p className="small">In Claude Code, in the project folder:</p>
                <Copy text={board === "main" ? "/whiteboard" : `/whiteboard ${board}`} />
              </>
            ) : (
              <>
                <p className="small">Connect Claude Code to the board:</p>
                <Copy text={`claude mcp add --transport http livingboard ${mcpUrl}`} />
                <p className="small">then, inside Claude Code:</p>
                <Copy text="/mcp__livingboard__start" />
              </>
            )}
          </div>
        )}
      </section>

      <div className="panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "board"} className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}>
          Board
        </button>
        <button type="button" role="tab" aria-selected={tab === "doc"} className={tab === "doc" ? "on" : ""} onClick={() => setTab("doc")}>
          Document{docCount ? ` · ${docCount}` : ""}
        </button>
      </div>

      {tab === "doc" ? (
        <section className="grow">
          <DocumentView model={model} onFocus={onFocus} />
        </section>
      ) : (
        <>
      <section>
        <h2>How the AI works</h2>
        <label className="field">
          <span>Recognition</span>
          <Segmented
            value={s.mode}
            options={[
              ["hybrid", "Hybrid"],
              ["implicit", "Implicit"],
            ]}
            onChange={(v) => model.setSetting("mode", v)}
          />
          <small className="muted">{HINTS.mode[s.mode]}</small>
        </label>
        <label className="field">
          <span>Effort</span>
          <Segmented
            value={s.effort}
            options={[
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
            ]}
            onChange={(v) => model.setSetting("effort", v)}
          />
          <small className="muted">{HINTS.effort[s.effort]}</small>
        </label>
        <label className="field">
          <span>Permissions</span>
          <Segmented
            value={s.permission}
            options={[
              ["read", "Read-only"],
              ["ask", "Ask"],
              ["auto", "Auto"],
            ]}
            onChange={(v) => model.setSetting("permission", v)}
          />
          <small className="muted">{HINTS.permission[s.permission]}</small>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={lens} onChange={(e) => onLens(e.target.checked)} />
          <span>AI lens: label, relations and status on every idea (off: a clean board, labels only on what you select)</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showBoxes} onChange={(e) => onShowBoxes(e.target.checked)} disabled={!lens} />
          <span>Always show idea outlines (otherwise only when needed)</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={tablet} onChange={(e) => onTablet(e.target.checked)} />
          <span>Tablet mode: pen to write, fingers to move around</span>
        </label>
      </section>

      <section>
        <h2>Emerging ontology</h2>
        {ontology.size === 0 ? (
          <p className="muted small">No types yet. Draw something: types emerge from how Claude reads the board.</p>
        ) : (
          <ul className="types">
            {[...ontology.values()].map((t) => (
              <li key={t.name} title={t.description}>
                <span className="type-dot" style={{ background: t.color }}>
                  {t.icon}
                </span>
                <span className="type-name">{t.name}</span>
                <span className="muted small">{counts.get(t.name) ?? 0}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Saved views</h2>
        {savedViews.length === 0 ? (
          <p className="muted small">Tap ☆ on a view's header to save it and reuse it on other nodes and boards.</p>
        ) : (
          <ul className="registry">
            {savedViews.map((v) => (
              <li key={v.name} title={v.description}>
                <div>
                  <b>{v.title}</b>
                  <span className="muted small">
                    {v.required.length ? ` · requires ${v.required.join(", ")}` : ""} · {v.author}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-btn small-btn"
                  aria-label={`Delete ${v.title}`}
                  onClick={() => {
                    if (window.confirm(`Delete “${v.title}” from the registry? Boards that use it keep it.`)) void deleteView(v.name);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {boardComments.length > 0 && (
        <section>
          <h2>Board notes</h2>
          <ul className="activity">
            {boardComments.slice(0, 5).map((c) => (
              <li key={c.id}>
                <span className="small">
                  <b>{c.author === "ai" ? "✳ Claude" : c.authorName}</b> {c.text}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="grow">
        <h2>Activity</h2>
        {activity.length === 0 ? (
          <p className="muted small">Here you'll see what Claude does, step by step.</p>
        ) : (
          <ul className="activity">
            {[...activity]
              .reverse()
              .slice(0, 40)
              .map((a) => (
                <li key={a.id}>
                  <button type="button" className={`act ${a.kind}`} onClick={() => a.nodeId && onFocus(a.nodeId)} disabled={!a.nodeId}>
                    <span>{a.text}</span>
                    <span className="muted small">{ago(now - a.at)}</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </section>

        </>
      )}

      <footer className="panel-foot">
        <button
          type="button"
          className="btn"
          disabled={proposal.has("current")}
          onClick={() => {
            const ok = model.proposeLayout();
            setTidyMsg(ok ? "" : "Nothing to tidy: it needs ideas connected by arrows.");
          }}
          title="Preview a tree layout that follows your arrows"
        >
          {proposal.has("current") ? "Tidy preview open" : "Tidy the board"}
        </button>
        {tidyMsg && <p className="muted small">{tidyMsg}</p>}
        <button type="button" className="btn" onClick={onExample}>
          Load example: weather app
        </button>
      </footer>
    </aside>
  );
}
