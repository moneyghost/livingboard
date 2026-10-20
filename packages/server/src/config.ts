import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

/** Where global boards (*.ydoc), the project registry and the view registry (views/*.json) live. */
export const DATA_DIR = process.env.LIVINGBOARD_DATA ?? join(import.meta.dirname, "..", "..", "..", "data");

export const PORT = Number(process.env.LIVINGBOARD_PORT ?? 3333);
// `--lan` (or LIVINGBOARD_HOST=0.0.0.0) exposes the board to other devices on the network.
export const HOST = process.env.LIVINGBOARD_HOST ?? (process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1");
export const WEB_DIST = join(import.meta.dirname, "..", "..", "web", "dist");
const DEV_WEB_PORT = 5180;

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
}

/** `pnpm dev` passes `--dev`: the page comes from Vite (hot reload), not from the build. */
export const DEV = process.argv.includes("--dev");

/**
 * Where people open the board: the built page served by this server, or the
 * Vite dev server (in dev, or when there is no build). LIVINGBOARD_WEB_URL overrides both.
 */
export function webBase(host = "localhost"): string {
  if (process.env.LIVINGBOARD_WEB_URL) return process.env.LIVINGBOARD_WEB_URL.replace(/\/$/, "");
  return !DEV && existsSync(WEB_DIST) ? `http://${host}:${PORT}` : `http://${host}:${DEV_WEB_PORT}`;
}
