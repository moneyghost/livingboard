import { CaptureUpdateAction, Excalidraw, WelcomeScreen } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardModel } from "./board";
import { Collab } from "./collab";
import { type DevicePrefs, loadDevicePrefs, saveDevicePrefs } from "./device";
import { Dock } from "./Dock";
import { buildExample } from "./example";
import { attachFingerNavigation } from "./gestures";
import type { Viewport } from "./geometry";
import { useYMap } from "./hooks";
import { loadIdentity } from "./identity";
import { Overlay } from "./Overlay";
import { Panel } from "./Panel";
import { redo, undo } from "./history";
import { refreshViews } from "./registry";
import { startRenderer } from "./rpc";

const params = new URLSearchParams(location.search);
const board = params.get("board")?.trim() || "main";
// A project's board (opened by /whiteboard in Claude Code): the server knows the project by its id.
const project = params.get("p")?.trim() || null;
/** What the server calls this board: `main`, or `<project>:<board>`. */
const boardKey = project ? `${project}:${board}` : board;
// The id is `<folder name>-<hash>`: the name alone is enough for people.
const projectName = project?.replace(/-[0-9a-f]{6}$/, "") ?? null;
document.title = projectName ? `${board} · ${projectName} · Sinapsi` : `${board} · Sinapsi`;
const me = loadIdentity();

export default function App() {
  const collab = useMemo(() => new Collab(boardKey, me), []);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const model = useMemo(() => new BoardModel(collab, () => apiRef.current), [collab]);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 });
  // The full AI lens is opt-in: by default the board shows drawings and Claude's messages only.
  const [lens, setLensState] = useState(() => {
    try {
      return localStorage.getItem("sinapsi:lens") === "1";
    } catch {
      return false;
    }
  });
  const setLens = (v: boolean) => {
    setLensState(v);
    try {
      localStorage.setItem("sinapsi:lens", v ? "1" : "0");
    } catch {
      // ignore
    }
  };
  // Outlines around every idea are noise most of the time: off unless asked (remembered per device).
  const [showBoxes, setShowBoxesState] = useState(() => {
    try {
      return localStorage.getItem("sinapsi:boxes") === "1";
    } catch {
      return false;
    }
  });
  const setShowBoxes = (v: boolean) => {
    setShowBoxesState(v);
    try {
      localStorage.setItem("sinapsi:boxes", v ? "1" : "0");
    } catch {
      // ignore
    }
  };
  const elements = useYMap(collab.elements);
  const lastPointer = useRef(0);
  const frame = useRef(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [device, setDeviceState] = useState<DevicePrefs>(loadDevicePrefs);
  const [activeTool, setActiveTool] = useState<string>("selection");
  const [selection, setSelection] = useState<string[]>([]);
  const groupsMap = useYMap(model.groups);
  const fingersNavigate = device.tablet && !device.fingerDraw;

  const setDevice = (patch: Partial<DevicePrefs>) => {
    const next = { ...device, ...patch };
    setDeviceState(next);
    saveDevicePrefs(next);
  };

  // Tablet: the pen draws, fingers belong to our navigation (pan, pinch, 2/3-finger taps).
  useEffect(() => {
    if (!fingersNavigate || !canvasRef.current) return;
    return attachFingerNavigation(canvasRef.current, { getApi: () => apiRef.current, onUndo: undo, onRedo: redo });
  }, [fingersNavigate]);

  useEffect(() => {
    if (!api) return;
    api.updateScene({ appState: { penMode: fingersNavigate, penDetected: fingersNavigate || api.getAppState().penDetected } });
  }, [api, fingersNavigate]);

  useEffect(() => {
    apiRef.current = api;
    if (!api) return;
    if (import.meta.env.DEV) Object.assign(window, { __excalidraw: api, __collab: collab });
    collab.attach(api);
    collab.onCollaborators = (collaborators) => api.updateScene({ collaborators });
  }, [api, collab]);

  useEffect(() => startRenderer(boardKey, () => apiRef.current), []);

  // The server pings every board when the view registry changes.
  useEffect(() => {
    const onAgent = (e: { keysChanged: Set<string> }) => e.keysChanged.has("registryAt") && void refreshViews();
    model.agent.observe(onAgent);
    return () => model.agent.unobserve(onAgent);
  }, [model]);
  useEffect(() => () => collab.destroy(), [collab]);

  const trackViewport = useCallback((s: AppState) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      setViewport((v) =>
        v.scrollX === s.scrollX && v.scrollY === s.scrollY && v.zoom === s.zoom.value && v.width === s.width && v.height === s.height
          ? v
          : { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value, width: s.width, height: s.height },
      );
    });
  }, []);

  const onChange = useCallback(
    (els: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      collab.pushLocal(els);
      collab.pushFiles(els, files);
      collab.presence(appState);
      trackViewport(appState);
      setActiveTool(appState.activeTool.type);
      const sel = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]);
      setSelection((prev) => (prev.length === sel.length && prev.every((id, i) => id === sel[i]) ? prev : sel));
    },
    [collab, trackViewport],
  );

  const loadExample = () => {
    if (!api) return;
    const s = api.getAppState();
    const z = s.zoom.value;
    const origin = { x: -s.scrollX + s.width / 2 / z - 330, y: -s.scrollY + s.height / 2 / z - 180 };
    const current = api.getSceneElementsIncludingDeleted();
    const last = current.reduce<string | null>((m, e) => (e.index && (!m || e.index > m) ? e.index : m), null);
    const added = buildExample(origin, last);
    api.updateScene({ elements: [...current, ...added], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    api.scrollToContent(added, { fitToViewport: true, viewportZoomFactor: 0.7, animate: true });
  };

  const focusNode = (nodeId: string) => {
    const c = model.candidates.get(nodeId);
    if (!api || !c) return;
    const s = api.getAppState();
    // From afar, come close enough to read (messages and labels open from zoom 0.5 up).
    const z = s.zoom.value < 0.8 ? 1 : s.zoom.value;
    const cx = c.bbox.x + c.bbox.w / 2;
    const cy = c.bbox.y + c.bbox.h / 2;
    // Zoom and scroll in one update: scrollToContent would still use the old zoom.
    api.updateScene({ appState: { zoom: { value: z as NormalizedZoomValue }, scrollX: s.width / (2 * z) - cx, scrollY: s.height / (2 * z) - cy } });
  };

  return (
    <div className={`app ${device.tablet ? "tablet" : ""} tool-${activeTool}`}>
      <div className="canvas-wrap" ref={canvasRef}>
        <Excalidraw
          // Excalidraw hands over its API from its constructor (mid-render): store it on the next tick.
          excalidrawAPI={(a) => queueMicrotask(() => setApi(a))}
          initialData={collab.initialData}
          onChange={onChange}
          onPointerUpdate={({ pointer, button }) => {
            const t = performance.now();
            if (t - lastPointer.current < 40) return;
            lastPointer.current = t;
            collab.pointer(pointer.x, pointer.y, pointer.tool, button);
          }}
          isCollaborating
          langCode="it-IT"
          name={projectName ? `${projectName} · ${board}` : `Sinapsi · ${board}`}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        >
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Logo>
                <span className="welcome-logo">✳ Sinapsi</span>
              </WelcomeScreen.Center.Logo>
              <WelcomeScreen.Center.Heading>
                Disegna un'idea. Claude la legge mentre disegni.
              </WelcomeScreen.Center.Heading>
              <WelcomeScreen.Center.Menu>
                <WelcomeScreen.Center.MenuItem onSelect={loadExample}>Carica l'esempio: app meteo</WelcomeScreen.Center.MenuItem>
              </WelcomeScreen.Center.Menu>
            </WelcomeScreen.Center>
            <WelcomeScreen.Hints.ToolbarHint />
          </WelcomeScreen>
        </Excalidraw>
        <Overlay
          model={model}
          board={boardKey}
          viewport={viewport}
          lens={lens}
          selection={selection}
          onFocus={focusNode}
          showBoxes={showBoxes}
          elements={elements}
        />
        <Dock
          api={api}
          tablet={device.tablet}
          activeTool={activeTool}
          fingerDraw={device.fingerDraw}
          onFingerDraw={(fingerDraw) => setDevice({ fingerDraw })}
          selection={selection}
          grouped={groupsMap.size > 0 && model.isGrouped(selection)}
          onGroup={() => model.groupAsIdea(selection)}
          onUngroup={() => model.releaseFromGroups(selection)}
        />
      </div>
      <Panel
        model={model}
        board={board}
        project={projectName}
        me={me}
        lens={lens}
        showBoxes={showBoxes}
        onShowBoxes={setShowBoxes}
        onLens={setLens}
        onExample={loadExample}
        onFocus={focusNode}
        tablet={device.tablet}
        onTablet={(tablet) => setDevice({ tablet })}
      />
    </div>
  );
}
