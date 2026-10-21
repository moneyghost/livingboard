import { existsSync, readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

// Set by the npm package build (packages/livingboard/build.mjs); undefined when running the sources.
declare const __LIVINGBOARD_BUNDLE__: string | undefined;

/**
 * True in the npm package (bundled JavaScript in `dist/`, the page in `web/`),
 * false when running the TypeScript sources from the repo.
 */
export const BUNDLED = typeof __LIVINGBOARD_BUNDLE__ !== "undefined";
export const VERSION = BUNDLED ? __LIVINGBOARD_BUNDLE__! : "dev";

/**
 * Where the project registry, the view registry (views/*.json), the LAN token and server.json live:
 * the user's ~/.livingboard for the npm package (its own folder may be replaced on update), `data/` in the repo.
 */
export const DATA_DIR =
  process.env.LIVINGBOARD_DATA ?? (BUNDLED ? join(homedir(), ".livingboard") : join(import.meta.dirname, "..", "..", "..", "data"));

export const DEFAULT_PORT = 3333;
/** LIVINGBOARD_PORT pins the port; otherwise the server moves to the next free one when 3333 is taken. */
export const PORT_PINNED = !!process.env.LIVINGBOARD_PORT;
export let PORT = Number(process.env.LIVINGBOARD_PORT ?? DEFAULT_PORT);
export function setPort(port: number) {
  PORT = port;
}

/** Written by the running server, read by the bridge and the hook to find it. */
export const SERVER_INFO = join(DATA_DIR, "server.json");
export function readServerPort(): number | null {
  try {
    const port = (JSON.parse(readFileSync(SERVER_INFO, "utf8")) as { port?: unknown }).port;
    return typeof port === "number" ? port : null;
  } catch {
    return null;
  }
}
// `--lan` (or LIVINGBOARD_HOST=0.0.0.0) exposes the board to other devices on the network.
export const HOST = process.env.LIVINGBOARD_HOST ?? (process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1");
export const WEB_DIST = BUNDLED ? join(import.meta.dirname, "..", "web") : join(import.meta.dirname, "..", "..", "web", "dist");
const DEV_WEB_PORT = 5180;

/** IPv4 addresses other devices may reach, home/office networks (192.168, 10, 172.16-31) first. */
export function lanAddresses(): string[] {
  const rank = (ip: string) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 2);
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address)
    .sort((a, b) => rank(a) - rank(b));
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
