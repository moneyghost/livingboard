import { convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { generateNKeysBetween } from "fractional-indexing";

type Pt = [number, number];

/** A hand-drawn umbrella, as two freehand strokes (absolute coordinates). */
const UMBRELLA: Pt[][] = [
  [
    [0, 40],
    [6, 24],
    [18, 10],
    [40, 2],
    [62, 10],
    [74, 24],
    [80, 40],
    [70, 35],
    [60, 41],
    [50, 35],
    [40, 41],
    [30, 35],
    [20, 41],
    [10, 35],
    [0, 40],
  ],
  [
    [40, 41],
    [41, 62],
    [40, 82],
    [37, 90],
    [31, 91],
    [27, 86],
  ],
];

function stroke(points: Pt[], ox: number, oy: number) {
  const [x0, y0] = points[0];
  const rel = points.map(([x, y]) => [x - x0, y - y0] as Pt);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  return {
    type: "freedraw",
    id: `ex_${Math.random().toString(36).slice(2, 10)}`,
    x: ox + x0,
    y: oy + y0,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points: rel,
    pressures: [],
    simulatePressure: true,
    strokeColor: "#1e1e1e",
    strokeWidth: 2,
    roughness: 1,
    opacity: 100,
    lastCommittedPoint: null,
  };
}

/**
 * A small product idea sketched on the board — an app, two features, where
 * the data comes from, a doodled icon and a question for the AI.
 */
export function buildExample(origin: { x: number; y: number }, lastIndex: string | null): ExcalidrawElement[] {
  const o = (x: number, y: number) => ({ x: origin.x + x, y: origin.y + y });
  const skeleton = [
    {
      type: "rectangle",
      id: "app",
      ...o(0, 0),
      width: 240,
      height: 110,
      backgroundColor: "#a5d8ff",
      fillStyle: "hachure",
      label: { text: "App: Meteo in bici\nsolo il tuo percorso" },
    },
    {
      type: "ellipse",
      id: "alert",
      ...o(440, -80),
      width: 210,
      height: 90,
      backgroundColor: "#d0bfff",
      fillStyle: "hachure",
      label: { text: "Avviso pioggia" },
    },
    {
      type: "diamond",
      id: "data",
      ...o(440, 130),
      width: 230,
      height: 130,
      backgroundColor: "#b2f2bb",
      fillStyle: "hachure",
      label: { text: "Dati\nprevisioni orarie" },
    },
    { type: "arrow", ...o(245, 40), width: 190, height: -70, start: { id: "app" }, end: { id: "alert" }, label: { text: "manda" } },
    { type: "arrow", ...o(245, 80), width: 190, height: 110, start: { id: "app" }, end: { id: "data" }, label: { text: "usa" } },
    { type: "text", ...o(130, 215), text: "icona: ombrello\nche si apre", fontSize: 16 },
    { type: "text", ...o(0, 380), text: "@AI quanto prima conviene avvisare?", fontSize: 20 },
  ] as unknown as ExcalidrawElementSkeleton[];

  const shapes = convertToExcalidrawElements(skeleton, { regenerateIds: true });
  const strokes = restoreElements(
    UMBRELLA.map((s) => stroke(s, origin.x + 20, origin.y + 195)) as unknown as ExcalidrawElement[],
    null,
  );
  const all = [...shapes, ...strokes];
  const keys = generateNKeysBetween(lastIndex, null, all.length);
  return all.map((el, i) => ({ ...el, index: keys[i] }) as ExcalidrawElement);
}
