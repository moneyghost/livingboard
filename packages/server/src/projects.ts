import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DATA_DIR } from "./config";

/**
 * Boards can belong to a project: a folder on this machine (the one Claude Code
 * runs in). Their files live in that folder, under `.livingboard/boards/`, so the
 * board travels and is versioned with the project. The browser only knows the
 * project id; this registry maps it back to the folder (and survives restarts).
 */

export interface Project {
  id: string;
  root: string;
  name: string;
}

const FILE = join(DATA_DIR, "projects.json");
let cache: Map<string, Project> | null = null;

function all(): Map<string, Project> {
  if (cache) return cache;
  cache = new Map();
  try {
    if (existsSync(FILE)) for (const p of JSON.parse(readFileSync(FILE, "utf8")) as Project[]) cache.set(p.id, p);
  } catch (err) {
    console.error("[projects] cannot read registry", err);
  }
  return cache;
}

/** Board names are file names: keep them simple. */
export function cleanBoardName(name?: string): string {
  return (name ?? "").trim().replace(/[^\w-]/g, "_").slice(0, 60) || "main";
}

function slug(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 32) || "progetto"
  );
}

/** Same folder → same id, on every run. Case-insensitive on Windows and macOS, like their file systems. */
export function registerProject(folder: string): Project {
  const root = resolve(folder);
  const norm = process.platform === "linux" ? root : root.toLowerCase();
  const id = `${slug(basename(root))}-${createHash("sha1").update(norm).digest("hex").slice(0, 6)}`;
  const map = all();
  if (map.get(id)?.root !== root) {
    map.set(id, { id, root, name: basename(root) });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, `${JSON.stringify([...map.values()], null, 2)}\n`);
  }
  const project = map.get(id)!;
  boardsDir(project); // moves a pre-rename `.sinapsi/` folder
  return project;
}

export function getProject(id: string): Project | undefined {
  return all().get(id);
}

export function boardsDir(p: Project): string {
  const dir = join(p.root, ".livingboard");
  // Projects from before the rename keep their boards in `.sinapsi/`: move them over once.
  const legacy = join(p.root, ".sinapsi");
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      renameSync(legacy, dir);
    } catch (err) {
      console.error(`[projects] cannot move ${legacy} to ${dir}`, err);
    }
  }
  return join(dir, "boards");
}

/** Boards saved in the project folder. */
export function savedBoards(p: Project): string[] {
  const dir = boardsDir(p);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ydoc"))
    .map((f) => f.slice(0, -5));
}

/** Board key: what the browser and the server share. `main` alone is the global board of old. */
export function boardKey(project: Project | undefined, name?: string): string {
  return project ? `${project.id}:${cleanBoardName(name)}` : cleanBoardName(name);
}

export function parseBoardKey(key: string): { project?: Project; projectId?: string; name: string } {
  const i = key.indexOf(":");
  if (i < 0) return { name: cleanBoardName(key) };
  const projectId = key.slice(0, i);
  return { projectId, project: getProject(projectId), name: cleanBoardName(key.slice(i + 1)) };
}
