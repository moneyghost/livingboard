import { useEffect, useState } from "react";
import type * as Y from "yjs";

/** Immutable snapshot of a Y.Map that re-renders on every change. */
/**
 * Y events can fire synchronously inside someone else's render/commit (e.g.
 * Excalidraw's onChange): defer and coalesce them into one update per tick.
 */
function deferred(fn: () => void) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      fn();
    });
  };
}

export function useYMap<T>(map: Y.Map<T>): Map<string, T> {
  const [snap, setSnap] = useState(() => new Map(map.entries()));
  useEffect(() => {
    const update = deferred(() => setSnap(new Map(map.entries())));
    map.observe(update);
    update();
    return () => map.unobserve(update);
  }, [map]);
  return snap;
}

export function useYArray<T>(arr: Y.Array<T>): T[] {
  const [snap, setSnap] = useState(() => arr.toArray());
  useEffect(() => {
    const update = deferred(() => setSnap(arr.toArray()));
    arr.observe(update);
    update();
    return () => arr.unobserve(update);
  }, [arr]);
  return snap;
}

/** Current time, refreshed every `ms` — for "x seconds ago" and rings. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
