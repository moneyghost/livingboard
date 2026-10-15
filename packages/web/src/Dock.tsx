import type { ExcalidrawImperativeAPI, ToolType } from "@excalidraw/excalidraw/types";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { redo, undo } from "./history";

type Ink = "pen" | "highlighter";
interface InkStyle {
  color: string;
  width: number;
}
type Prefs = Record<Ink, InkStyle>;

const INK: Record<Ink, { colors: string[]; widths: number[]; opacity: number }> = {
  pen: { colors: ["#1e1e1e", "#1971c2", "#e03131", "#2f9e44", "#f08c00"], widths: [0.5, 1, 2], opacity: 100 },
  highlighter: { colors: ["#ffd43b", "#8ce99a", "#faa2c1", "#74c0fc", "#ffa94d"], widths: [3, 5, 8], opacity: 35 },
};

const DEFAULT_PREFS: Prefs = { pen: { color: "#1e1e1e", width: 1 }, highlighter: { color: "#ffd43b", width: 5 } };
const KEY = "sinapsi:ink";

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // storage blocked
  }
  return DEFAULT_PREFS;
}

const SHAPES: { type: ToolType; label: string; icon: ReactNode }[] = [
  { type: "rectangle", label: "Rettangolo", icon: <rect x="4" y="6" width="16" height="12" rx="2" /> },
  { type: "ellipse", label: "Ellisse", icon: <ellipse cx="12" cy="12" rx="9" ry="7" /> },
  { type: "diamond", label: "Rombo", icon: <path d="M12 3 21 12 12 21 3 12Z" /> },
  { type: "arrow", label: "Freccia", icon: <path d="M5 19 19 5M10 5h9v9" /> },
  { type: "line", label: "Linea", icon: <path d="M5 19 19 5" /> },
];

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const I = {
  undo: (
    <Icon>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Icon>
  ),
  redo: (
    <Icon>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </Icon>
  ),
  pen: (
    <Icon>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Icon>
  ),
  highlighter: (
    <Icon>
      <path d="m9 11-6 6v3h9l3-3" />
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </Icon>
  ),
  eraser: (
    <Icon>
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </Icon>
  ),
  select: (
    <Icon>
      <path d="M4 4l7 17 2.5-7.5L21 11Z" />
    </Icon>
  ),
  text: (
    <Icon>
      <path d="M4 7V4h16v3" />
      <path d="M9 20h6" />
      <path d="M12 4v16" />
    </Icon>
  ),
  shapes: (
    <Icon>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <circle cx="17" cy="17" r="4" />
    </Icon>
  ),
  image: (
    <Icon>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </Icon>
  ),
  hand: (
    <Icon>
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </Icon>
  ),
};

interface Props {
  api: ExcalidrawImperativeAPI | null;
  tablet: boolean;
  activeTool: ToolType | string;
  fingerDraw: boolean;
  onFingerDraw: (v: boolean) => void;
  /** Selected element ids: offer to declare them one idea for the AI. */
  selection: string[];
  grouped: boolean;
  onGroup: () => void;
  onUngroup: () => void;
}

const GroupButtons = ({ selection, grouped, onGroup, onUngroup }: Pick<Props, "selection" | "grouped" | "onGroup" | "onUngroup">) =>
  selection.length ? (
    <>
      <button type="button" className="dock-text-btn" onClick={onGroup} title="Claude legge la selezione come un'unica idea">
        ⧉ È un'idea
      </button>
      {grouped && (
        <button type="button" className="dock-text-btn" onClick={onUngroup} title="Torna al raggruppamento automatico">
          ↺ Automatico
        </button>
      )}
    </>
  ) : null;

/**
 * Big, touch-friendly toolbar. On tablets it replaces Excalidraw's toolbar
 * (GoodNotes-style inks, colors and sizes); on desktop it is just a clear
 * undo/redo pair.
 */
export function Dock({ api, tablet, activeTool, fingerDraw, onFingerDraw, selection, grouped, onGroup, onUngroup }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [ink, setInk] = useState<Ink>("pen");
  const [shapesOpen, setShapesOpen] = useState(false);
  const booted = useRef(false);

  const savePrefs = (next: Prefs) => {
    setPrefs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const pickInk = (k: Ink, style = prefs[k]) => {
    if (!api) return;
    api.setActiveTool({ type: "freedraw" });
    api.updateScene({
      appState: { currentItemStrokeColor: style.color, currentItemStrokeWidth: style.width, currentItemOpacity: INK[k].opacity },
    });
    setInk(k);
    setShapesOpen(false);
  };

  const pickTool = (type: ToolType) => {
    if (!api) return;
    api.setActiveTool({ type });
    const isShape = SHAPES.some((s) => s.type === type);
    if (isShape || type === "text") {
      api.updateScene({ appState: { currentItemOpacity: 100, currentItemStrokeColor: prefs.pen.color, currentItemStrokeWidth: 2 } });
    }
    setShapesOpen(isShape);
  };

  // Tablets open with the pen in hand, like a notebook.
  useEffect(() => {
    if (!api || !tablet || booted.current) return;
    booted.current = true;
    pickInk("pen");
  });

  const inkActive = activeTool === "freedraw";
  const shapeActive = SHAPES.some((s) => s.type === activeTool);

  if (!tablet) {
    return (
      <div className="dock dock-compact">
        <button type="button" onClick={undo} title="Annulla (Ctrl+Z)">
          {I.undo}
          <span>Annulla</span>
        </button>
        <button type="button" onClick={redo} title="Ripeti (Ctrl+Shift+Z)">
          <span>Ripeti</span>
          {I.redo}
        </button>
        {selection.length > 0 && <span className="dock-sep" />}
        <GroupButtons selection={selection} grouped={grouped} onGroup={onGroup} onUngroup={onUngroup} />
      </div>
    );
  }

  const style = prefs[ink];
  const showShapes = (shapesOpen || shapeActive) && !inkActive;
  return (
    <div className="dock-stack" onPointerDown={(e) => e.stopPropagation()}>
      <div className="dock">
        <button type="button" className="dock-btn" onClick={undo} title="Annulla (tap con due dita)">
          {I.undo}
        </button>
        <button type="button" className="dock-btn" onClick={redo} title="Ripeti (tap con tre dita)">
          {I.redo}
        </button>
        <span className="dock-sep" />
        <button type="button" className={`dock-btn ${inkActive && ink === "pen" ? "on" : ""}`} onClick={() => pickInk("pen")} title="Penna">
          {I.pen}
        </button>
        <button
          type="button"
          className={`dock-btn ${inkActive && ink === "highlighter" ? "on" : ""}`}
          onClick={() => pickInk("highlighter")}
          title="Evidenziatore"
        >
          {I.highlighter}
        </button>
        <button type="button" className={`dock-btn ${activeTool === "eraser" ? "on" : ""}`} onClick={() => pickTool("eraser")} title="Gomma">
          {I.eraser}
        </button>
        <button type="button" className={`dock-btn ${activeTool === "selection" ? "on" : ""}`} onClick={() => pickTool("selection")} title="Seleziona">
          {I.select}
        </button>
        <button type="button" className={`dock-btn ${activeTool === "text" ? "on" : ""}`} onClick={() => pickTool("text")} title="Testo">
          {I.text}
        </button>
        <button
          type="button"
          className={`dock-btn ${shapeActive || shapesOpen ? "on" : ""}`}
          onClick={() => (shapeActive ? pickTool("selection") : setShapesOpen(!shapesOpen))}
          title="Forme"
        >
          {I.shapes}
        </button>
        <button
          type="button"
          className="dock-btn"
          onClick={() => api?.setActiveTool({ type: "image", insertOnCanvasDirectly: true })}
          title="Inserisci una foto o un'immagine"
        >
          {I.image}
        </button>
        <span className="dock-sep" />
        <button
          type="button"
          className={`dock-btn finger ${fingerDraw ? "on" : ""}`}
          onClick={() => onFingerDraw(!fingerDraw)}
          title={fingerDraw ? "Il dito disegna: tocca per usarlo solo per spostarti" : "Il dito sposta e zooma: tocca per disegnare col dito"}
        >
          {I.hand}
          <span className="finger-label">{fingerDraw ? "disegna" : "naviga"}</span>
        </button>
      </div>

      {inkActive && (
        <div className="dock dock-sub">
          {INK[ink].colors.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch ${style.color === c ? "on" : ""}`}
              style={{ "--c": c } as React.CSSProperties}
              onClick={() => {
                const next = { ...prefs, [ink]: { ...style, color: c } };
                savePrefs(next);
                pickInk(ink, next[ink]);
              }}
              aria-label={`Colore ${c}`}
            />
          ))}
          <span className="dock-sep" />
          {INK[ink].widths.map((w, i) => (
            <button
              key={w}
              type="button"
              className={`width ${style.width === w ? "on" : ""}`}
              onClick={() => {
                const next = { ...prefs, [ink]: { ...style, width: w } };
                savePrefs(next);
                pickInk(ink, next[ink]);
              }}
              aria-label={["Sottile", "Medio", "Spesso"][i]}
            >
              <i style={{ width: 4 + i * 4, height: 4 + i * 4, background: ink === "highlighter" ? style.color : "currentColor" }} />
            </button>
          ))}
        </div>
      )}

      {activeTool === "selection" && selection.length > 0 && (
        <div className="dock dock-sub">
          <GroupButtons selection={selection} grouped={grouped} onGroup={onGroup} onUngroup={onUngroup} />
        </div>
      )}

      {showShapes && (
        <div className="dock dock-sub">
          {SHAPES.map((sh) => (
            <button key={sh.type} type="button" className={`dock-btn ${activeTool === sh.type ? "on" : ""}`} onClick={() => pickTool(sh.type)} title={sh.label}>
              <Icon>{sh.icon}</Icon>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
