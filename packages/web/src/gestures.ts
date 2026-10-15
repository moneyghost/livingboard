import type { ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";

interface Options {
  getApi: () => ExcalidrawImperativeAPI | null;
  onUndo: () => void;
  onRedo: () => void;
}

type Pt = { x: number; y: number };

const TAP_MS = 350;
const TAP_SLOP = 12;
const PAN_SLOP = 8;
const PALM_GUARD_MS = 400;

/**
 * GoodNotes-style finger navigation on top of Excalidraw. Finger touches that
 * land on the canvas never reach Excalidraw: one finger pans, two fingers
 * pinch-zoom around their center, a two-finger tap undoes and a three-finger
 * tap redoes. While the pen is down (and shortly after) touches are ignored, so
 * a resting palm cannot scroll the board. Touches on UI (menus, chips, views)
 * are left alone.
 */
export function attachFingerNavigation(root: HTMLElement, opts: Options): () => void {
  const touches = new Map<number, Pt>();
  const startPts = new Map<number, Pt>();
  type Base = { scrollX: number; scrollY: number; zoom: number; center: Pt; dist: number };
  let gesture: { time: number; maxTouches: number; moved: number; panning: boolean; base: Base | null } | null = null;
  let penDown = false;
  let penUpAt = 0;
  let frame = 0;
  let pending: { scrollX: number; scrollY: number; zoom: number } | null = null;

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onCanvas = (t: EventTarget | null) => t instanceof HTMLCanvasElement && !!t.closest(".excalidraw");
  const palmGuard = () => penDown || Date.now() - penUpAt < PALM_GUARD_MS;

  const center = (): Pt => {
    const pts = [...touches.values()].slice(0, 2);
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  };
  const spread = (): number => {
    const pts = [...touches.values()];
    return pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };

  /** Re-anchor on the current fingers (gesture start, finger added or lifted). */
  const rebase = () => {
    const api = opts.getApi();
    if (!api || !gesture || !touches.size) return;
    const s = pending ?? { scrollX: api.getAppState().scrollX, scrollY: api.getAppState().scrollY, zoom: api.getAppState().zoom.value };
    gesture.base = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom, center: center(), dist: spread() };
  };

  const flush = () => {
    frame = 0;
    const api = opts.getApi();
    if (!api || !pending) return;
    api.updateScene({
      appState: { scrollX: pending.scrollX, scrollY: pending.scrollY, zoom: { value: pending.zoom as NormalizedZoomValue } },
    });
    pending = null;
  };

  const apply = () => {
    const b = gesture?.base;
    if (!b) return;
    const c = center();
    const zoom = touches.size >= 2 && b.dist > 0 ? Math.min(30, Math.max(0.1, b.zoom * (spread() / b.dist))) : b.zoom;
    // Keep the scene point that was under the fingers' center under it.
    const sceneX = b.center.x / b.zoom - b.scrollX;
    const sceneY = b.center.y / b.zoom - b.scrollY;
    pending = { scrollX: c.x / zoom - sceneX, scrollY: c.y / zoom - sceneY, zoom };
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "pen") {
      penDown = true;
      gesture = null;
      touches.clear();
      startPts.clear();
      return;
    }
    if (e.pointerType !== "touch" || !onCanvas(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    if (palmGuard()) return;
    const p = local(e);
    touches.set(e.pointerId, p);
    startPts.set(e.pointerId, p);
    gesture ??= { time: Date.now(), maxTouches: 0, moved: 0, panning: false, base: null };
    gesture.maxTouches = Math.max(gesture.maxTouches, touches.size);
    rebase();
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    e.stopPropagation();
    e.preventDefault();
    if (!gesture) return;
    const p = local(e);
    touches.set(e.pointerId, p);
    const s = startPts.get(e.pointerId) ?? p;
    gesture.moved = Math.max(gesture.moved, Math.hypot(p.x - s.x, p.y - s.y));
    if (touches.size === 1 && !gesture.panning && gesture.moved < PAN_SLOP) return;
    gesture.panning = true;
    apply();
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerType === "pen") {
      penDown = false;
      penUpAt = Date.now();
      return;
    }
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    e.stopPropagation();
    touches.delete(e.pointerId);
    startPts.delete(e.pointerId);
    if (!gesture) return;
    if (touches.size > 0) {
      rebase();
      return;
    }
    const tap = e.type === "pointerup" && Date.now() - gesture.time < TAP_MS && gesture.moved < TAP_SLOP;
    if (tap && gesture.maxTouches === 2) opts.onUndo();
    if (tap && gesture.maxTouches === 3) opts.onRedo();
    gesture = null;
  };

  // Keep Excalidraw's own touch handlers (double-tap, long-press menu) and
  // Safari's pinch "gesture" events away: on the canvas, fingers are ours.
  const swallowTouch = (e: TouchEvent) => {
    if (!onCanvas(e.target)) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  };
  const swallowGesture = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const cap = { capture: true, passive: false } as const;
  const gestures = ["gesturestart", "gesturechange", "gestureend"];
  root.addEventListener("pointerdown", onDown, cap);
  window.addEventListener("pointermove", onMove, cap);
  window.addEventListener("pointerup", onUp, cap);
  window.addEventListener("pointercancel", onUp, cap);
  for (const t of ["touchstart", "touchmove", "touchend"] as const) root.addEventListener(t, swallowTouch, cap);
  for (const t of gestures) window.addEventListener(t, swallowGesture, cap);

  return () => {
    root.removeEventListener("pointerdown", onDown, cap);
    window.removeEventListener("pointermove", onMove, cap);
    window.removeEventListener("pointerup", onUp, cap);
    window.removeEventListener("pointercancel", onUp, cap);
    for (const t of ["touchstart", "touchmove", "touchend"] as const) root.removeEventListener(t, swallowTouch, cap);
    for (const t of gestures) window.removeEventListener(t, swallowGesture, cap);
    if (frame) cancelAnimationFrame(frame);
  };
}
