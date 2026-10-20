import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SavedView, slugify } from "@livingboard/shared";
import { DATA_DIR } from "./config";

/**
 * The view registry: interactive views people chose to keep, shared by every
 * board on this server. One JSON file per view so they are easy to inspect,
 * version and hand-edit.
 */
const DIR = join(DATA_DIR, "views");
let cache: Map<string, SavedView> | null = null;

function load(): Map<string, SavedView> {
  if (cache) return cache;
  cache = new Map();
  if (!existsSync(DIR)) return cache;
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const v = JSON.parse(readFileSync(join(DIR, file), "utf8")) as SavedView;
      cache.set(v.name, v);
    } catch (err) {
      console.error(`[registry] skipping ${file}`, err);
    }
  }
  return cache;
}

export function listViews(): SavedView[] {
  return [...load().values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getView(name: string): SavedView | undefined {
  return load().get(name);
}

export interface SaveInput {
  name?: string;
  title: string;
  description?: string;
  required?: string[];
  types?: string[];
  html: string;
  width?: number;
  height?: number;
  author?: string;
}

export function saveView(input: SaveInput): SavedView {
  if (!input.html?.trim()) throw new Error("La vista non ha HTML.");
  if (!input.title?.trim()) throw new Error("Serve un titolo.");
  if (input.html.length > 200_000) throw new Error("Vista troppo grande (max 200 KB).");
  const name = slugify(input.name || input.title);
  const old = load().get(name);
  const now = Date.now();
  const view: SavedView = {
    name,
    title: input.title.trim(),
    description: (input.description ?? old?.description ?? "").trim(),
    required: (input.required ?? old?.required ?? []).map((p) => p.trim()).filter(Boolean),
    types: (input.types ?? old?.types ?? []).map((t) => t.trim()).filter(Boolean),
    html: input.html,
    width: input.width ?? old?.width ?? 360,
    height: input.height ?? old?.height ?? 280,
    author: input.author ?? old?.author ?? "sconosciuto",
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${name}.json`), `${JSON.stringify(view, null, 2)}\n`);
  load().set(name, view);
  return view;
}

export function deleteView(name: string): boolean {
  const view = load().get(name);
  if (!view) return false;
  rmSync(join(DIR, `${view.name}.json`), { force: true });
  load().delete(name);
  return true;
}
