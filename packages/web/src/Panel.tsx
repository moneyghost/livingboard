import { Sidebar } from "@excalidraw/excalidraw";
import { type AgentState, type AINode, type Comment, DEFAULT_SETTINGS, type Settings } from "@livingboard/shared";
import { useState } from "react";
import type { BoardModel } from "./board";
import { useNow, useYArray, useYMap } from "./hooks";
import { DocumentView } from "./Document";
import { deleteView, useSavedViews } from "./registry";
import type { Identity } from "./identity";
import { LanPair } from "./Lan";

/** Excalidraw sidebar name: one sidebar is open at a time, so ours and the Library take turns. */
export const PANEL = "livingboard";
export type PanelTab = "activity" | "doc" | "settings";

function ago(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** Is Claude there, and what is it doing? Shared by the trigger and the panel. */
function useAgentStatus(model: BoardModel) {
  const agentMap = useYMap(model.agent);
  const candidates = useYMap(model.candidates);
  const now = useNow(1000);
  const agent = agentMap.get("state") as AgentState | undefined;
  const since = agent?.lastSeen ? now - agent.lastSeen : Infinity;
  const status =
    agent?.listening && since < 60_000
      ? { cls: "listening", text: "Listening" }
      : since < 20_000
        ? { cls: "working", text: "Working" }
        : since < 120_000
          ? { cls: "idle", text: "Connected" }
          : { cls: "off", text: "Not connected" };
  const queued = [...candidates.values()].filter((c) => c.state === "ready").length;
  return { agent, since, status, queued, now };
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

function Switch(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; hint?: string }) {
  return (
    <label className={`switch-row ${props.disabled ? "disabled" : ""}`}>
      <span className="switch-text">
        <span>{props.label}</span>
        {props.hint && <small className="muted">{props.hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </label>
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
  effort: {
    low: "Only answers @AI questions.",
    medium: "Reads everything that settles and builds what is clear.",
    high: "More proactive: builds and proposes ghost ideas.",
  },
} as const;

/** The button next to Excalidraw's Library: opens the panel and shows Claude's state while it is closed. */
export function PanelTrigger({ model }: { model: BoardModel }) {
  const { status, queued } = useAgentStatus(model);
  return (
    <Sidebar.Trigger
      name={PANEL}
      tab="activity"
      className="lb-trigger"
      title={`Claude: ${status.text.toLowerCase()}${queued ? ` · ${queued} to read` : ""}`}
      icon={
        <span className="lb-trigger-icon">
          ✳<span className={`status-dot ${status.cls}`} />
        </span>
      }
    >
      Claude
    </Sidebar.Trigger>
  );
}

interface Props {
  model: BoardModel;
  board: string;
  /** Folder name of the project the board belongs to. */
  project: string;
  me: Identity;
  lens: boolean;
  onLens: (v: boolean) => void;
  showBoxes: boolean;
  onShowBoxes: (v: boolean) => void;
  onFocus: (nodeId: string) => void;
  tablet: boolean;
  onTablet: (v: boolean) => void;
  docked: boolean;
  onDock: (v: boolean) => void;
  /** Open tab (null: closed), for the app to widen the Document. */
  onTabChange: (tab: PanelTab | null) => void;
}

export function Panel(props: Props) {
  const { model, board, project, me, onFocus } = props;
  const settingsMap = useYMap(model.settings);
  const ontology = useYMap(model.ontology);
  const nodes = useYMap(model.nodes);
  const comments = useYMap(model.comments);
  const savedViews = useSavedViews();
  const activity = useYArray(model.activity);
  const docCount = useYMap(model.docSections).size;
  const { agent, since, status, queued, now } = useAgentStatus(model);

  const s: Settings = { ...DEFAULT_SETTINGS, ...(Object.fromEntries(settingsMap) as Partial<Settings>) };
  const counts = new Map<string, number>();
  for (const n of nodes.values() as Iterable<AINode>) if (n.status !== "rejected") counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const boardComments = [...(comments.values() as Iterable<Comment>)].filter((c) => !c.nodeId).sort((a, b) => b.at - a.at);

  return (
    <Sidebar
      name={PANEL}
      className="lb-sidebar"
      docked={props.docked}
      onDock={props.onDock}
      onStateChange={(st) => props.onTabChange(st?.name === PANEL ? ((st.tab as PanelTab | undefined) ?? "activity") : null)}
    >
      <Sidebar.Header>
        <div className="lb-head">
          <div className="lb-status">
            <span className={`status-dot ${status.cls}`} />
            <strong>Claude</strong>
            <span className="muted">{status.text.toLowerCase()}</span>
            {agent?.lastSeen && status.cls !== "off" ? <span className="muted small">· {ago(since)}</span> : null}
          </div>
          <a className="lb-where small muted" href="/" title="All projects and boards">
            {project} · {board}
          </a>
        </div>
      </Sidebar.Header>

      {(status.cls === "off" || (agent?.activity && since < 30_000) || queued > 0) && (
        <div className={`lb-agent ${status.cls}`}>
          {agent?.activity && since < 30_000 && <p className="lb-doing">{agent.activity}</p>}
          {queued > 0 && <p className="small muted">{queued === 1 ? "1 item" : `${queued} items`} waiting to be read</p>}
          {status.cls === "off" && (
            <>
              <p className="small">In Claude Code, in the project folder:</p>
              <Copy text={board === "main" ? "/whiteboard" : `/whiteboard ${board}`} />
            </>
          )}
        </div>
      )}

      <Sidebar.Tabs>
        <Sidebar.TabTriggers>
          <Sidebar.TabTrigger tab="activity">Activity</Sidebar.TabTrigger>
          <Sidebar.TabTrigger tab="doc">Document{docCount ? ` ${docCount}` : ""}</Sidebar.TabTrigger>
          <Sidebar.TabTrigger tab="settings">Settings</Sidebar.TabTrigger>
        </Sidebar.TabTriggers>

        <Sidebar.Tab tab="activity">
          {ontology.size > 0 && (
            <section>
              <h2>What Claude sees</h2>
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
            </section>
          )}

          {boardComments.length > 0 && (
            <section>
              <h2>Board notes</h2>
              <ul className="notes">
                {boardComments.slice(0, 5).map((c) => (
                  <li key={c.id} className={c.author === "ai" ? "ai" : ""}>
                    <b>{c.author === "ai" ? "✳ Claude" : c.authorName}</b> {c.text}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="grow">
            <h2>Activity</h2>
            {activity.length === 0 ? (
              <p className="muted small">What Claude reads and draws shows up here, step by step. Click a step to jump to it on the board.</p>
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
        </Sidebar.Tab>

        <Sidebar.Tab tab="doc">
          <section className="grow">
            <DocumentView model={model} onFocus={onFocus} />
          </section>
        </Sidebar.Tab>

        <Sidebar.Tab tab="settings">
          <section>
            <h2>Claude on this board</h2>
            <div className="field">
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
            </div>
          </section>

          <section>
            <h2>On this device</h2>
            <Switch label="AI lens" hint="Label, relations and status on every idea" checked={props.lens} onChange={props.onLens} />
            <Switch
              label="Idea outlines"
              hint="Always show the outline of each idea"
              checked={props.showBoxes}
              onChange={props.onShowBoxes}
              disabled={!props.lens}
            />
            <Switch label="Tablet mode" hint="Pen to write, fingers to move around" checked={props.tablet} onChange={props.onTablet} />
          </section>

          <section>
            <h2>Other devices</h2>
            <LanPair path={location.pathname + location.search} />
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

          <section className="grow">
            <p className="small muted">
              You are <b style={{ color: me.color }}>{me.name}</b> on this board.
            </p>
          </section>
        </Sidebar.Tab>
      </Sidebar.Tabs>
    </Sidebar>
  );
}
