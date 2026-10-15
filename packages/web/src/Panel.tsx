import { type AgentState, type AINode, type Comment, DEFAULT_SETTINGS, type Settings } from "@sinapsi/shared";
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
  if (s < 5) return "ora";
  if (s < 60) return `${s}s fa`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min fa`;
  return `${Math.round(m / 60)} h fa`;
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
        {done ? "✓" : "Copia"}
      </button>
    </div>
  );
}

const HINTS = {
  mode: {
    hybrid: "Claude propone come legge ogni cosa; costruisce solo ciò che confermi.",
    implicit: "Claude interpreta e agisce subito; tu correggi quando sbaglia.",
  },
  effort: {
    low: "Risponde solo alle domande @AI.",
    medium: "Legge tutto ciò che si assesta e costruisce ciò che è chiaro.",
    high: "Più proattivo: costruisce e propone idee fantasma.",
  },
  permission: {
    read: "Niente file né sistemi esterni.",
    ask: "Chiede sulla lavagna prima di costruire.",
    auto: "Azioni reversibili subito; chiede per quelle irreversibili.",
  },
} as const;

export function Panel({ model, board, me, lens, onLens, showBoxes, onShowBoxes, onExample, onFocus, tablet, onTablet }: Props) {
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
      ? { cls: "listening", text: "Claude è in ascolto" }
      : since < 20_000
        ? { cls: "working", text: "Claude sta lavorando" }
        : since < 120_000
          ? { cls: "idle", text: "Claude collegato" }
          : { cls: "off", text: "Claude non collegato" };

  const queued = [...candidates.values()].filter((c) => c.state === "ready").length;
  const counts = new Map<string, number>();
  for (const n of nodes.values() as Iterable<AINode>) if (n.status !== "rejected") counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const boardComments = [...(comments.values() as Iterable<Comment>)].filter((c) => !c.nodeId).sort((a, b) => b.at - a.at);
  const mcpUrl = `${location.protocol}//${SERVER_HOST}/mcp`.replace("127.0.0.1", "localhost");

  if (collapsed) {
    return (
      <button type="button" className="panel-tab" onClick={() => setCollapsed(false)} title="Apri il pannello Sinapsi">
        <span className={`status-dot ${status.cls}`} />✳
      </button>
    );
  }

  return (
    <aside className={`panel ${tab === "doc" ? "wide" : ""}`}>
      <header className="panel-head">
        <div>
          <h1>✳ Sinapsi</h1>
          <span className="muted small">
            lavagna <b>{board}</b> · tu sei <b style={{ color: me.color }}>{me.name}</b>
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={() => setCollapsed(true)} title="Chiudi pannello">
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
            {queued === 1 ? "1 elemento" : `${queued} elementi`} da leggere
          </p>
        )}
        {status.cls === "off" && (
          <div className="connect">
            <p className="small">Collega Claude Code alla lavagna:</p>
            <Copy text={`claude mcp add --transport http sinapsi ${mcpUrl}`} />
            <p className="small">poi, dentro Claude Code:</p>
            <Copy text="/mcp__sinapsi__start" />
          </div>
        )}
      </section>

      <div className="panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "board"} className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}>
          Lavagna
        </button>
        <button type="button" role="tab" aria-selected={tab === "doc"} className={tab === "doc" ? "on" : ""} onClick={() => setTab("doc")}>
          Documento{docCount ? ` · ${docCount}` : ""}
        </button>
      </div>

      {tab === "doc" ? (
        <section className="grow">
          <DocumentView model={model} onFocus={onFocus} />
        </section>
      ) : (
        <>
      <section>
        <h2>Come lavora l'AI</h2>
        <label className="field">
          <span>Riconoscimento</span>
          <Segmented
            value={s.mode}
            options={[
              ["hybrid", "Ibrido"],
              ["implicit", "Implicito"],
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
              ["low", "Basso"],
              ["medium", "Medio"],
              ["high", "Alto"],
            ]}
            onChange={(v) => model.setSetting("effort", v)}
          />
          <small className="muted">{HINTS.effort[s.effort]}</small>
        </label>
        <label className="field">
          <span>Permessi</span>
          <Segmented
            value={s.permission}
            options={[
              ["read", "Sola lettura"],
              ["ask", "Chiedi"],
              ["auto", "Auto"],
            ]}
            onChange={(v) => model.setSetting("permission", v)}
          />
          <small className="muted">{HINTS.permission[s.permission]}</small>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={lens} onChange={(e) => onLens(e.target.checked)} />
          <span>Lente AI: etichetta, relazioni e stato su ogni idea (spenta: lavagna pulita, l'etichetta compare solo su ciò che selezioni)</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showBoxes} onChange={(e) => onShowBoxes(e.target.checked)} disabled={!lens} />
          <span>Mostra sempre i riquadri delle idee (altrimenti solo quando servono)</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={tablet} onChange={(e) => onTablet(e.target.checked)} />
          <span>Modalità tablet: penna per scrivere, dita per spostarti</span>
        </label>
      </section>

      <section>
        <h2>Ontologia emergente</h2>
        {ontology.size === 0 ? (
          <p className="muted small">Nessun tipo, per ora. Disegna qualcosa: i tipi nascono da come Claude legge la lavagna.</p>
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
        <h2>Viste salvate</h2>
        {savedViews.length === 0 ? (
          <p className="muted small">Tocca ☆ sull'intestazione di una vista per salvarla e riusarla su altri nodi e lavagne.</p>
        ) : (
          <ul className="registry">
            {savedViews.map((v) => (
              <li key={v.name} title={v.description}>
                <div>
                  <b>{v.title}</b>
                  <span className="muted small">
                    {v.required.length ? ` · richiede ${v.required.join(", ")}` : ""} · {v.author}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-btn small-btn"
                  aria-label={`Elimina ${v.title}`}
                  onClick={() => {
                    if (window.confirm(`Eliminare «${v.title}» dal registro? Le lavagne che la usano la tengono.`)) void deleteView(v.name);
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
          <h2>Note sulla lavagna</h2>
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
        <h2>Attività</h2>
        {activity.length === 0 ? (
          <p className="muted small">Qui vedrai cosa fa Claude, passo per passo.</p>
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
            setTidyMsg(ok ? "" : "Niente da riordinare: servono idee collegate da frecce.");
          }}
          title="Anteprima di un riordino ad albero che segue le tue frecce"
        >
          {proposal.has("current") ? "Anteprima del riordino aperta" : "Riordina la lavagna"}
        </button>
        {tidyMsg && <p className="muted small">{tidyMsg}</p>}
        <button type="button" className="btn" onClick={onExample}>
          Carica esempio: app meteo
        </button>
      </footer>
    </aside>
  );
}
