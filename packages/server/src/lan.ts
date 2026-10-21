import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { DATA_DIR, HOST } from "./config";

/**
 * With `--lan` the board is reachable from the network. Other devices need the
 * access token: they get it once from the QR code shown on this computer
 * (`/?t=<token>`), which turns into a cookie. Requests from this machine never
 * need it. The token survives restarts, so a paired tablet stays paired, and
 * "reset" on this computer unpairs every device.
 */

const FILE = join(DATA_DIR, "lan.json");
export const COOKIE = "livingboard_token";
let token: string | null = null;

export const LAN = HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1";

export function lanToken(): string {
  if (token) return token;
  try {
    if (existsSync(FILE)) token = (JSON.parse(readFileSync(FILE, "utf8")) as { token?: string }).token ?? null;
  } catch {
    token = null;
  }
  return token ?? resetLanToken();
}

export function resetLanToken(): string {
  token = randomBytes(18).toString("base64url");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, `${JSON.stringify({ token }, null, 2)}\n`);
  return token;
}

export function isLocal(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** May this request see and edit boards? */
export function authorized(req: IncomingMessage): boolean {
  if (isLocal(req)) return true;
  if (!LAN) return false;
  const given = cookieToken(req) ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  return !!given && same(given, lanToken());
}

export function validToken(t: string | null): boolean {
  return LAN && !!t && same(t, lanToken());
}

export function tokenCookie(): string {
  return `${COOKIE}=${encodeURIComponent(lanToken())}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}
