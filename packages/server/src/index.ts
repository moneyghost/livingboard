import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebSocketServer } from "ws";
import { getBoard, notifyRegistryChanged } from "./board";
import { createMcpServer } from "./mcp";
import { deleteView, listViews, saveView } from "./registry";
import { registerRenderer } from "./render";

const PORT = Number(process.env.SINAPSI_PORT ?? 3333);
// `--lan` (or SINAPSI_HOST=0.0.0.0) exposes the board to other devices on the network.
const HOST = process.env.SINAPSI_HOST ?? (process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1");
const WEB_DIST = join(import.meta.dirname, "..", "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/**
 * Browsers attach an Origin header; MCP clients don't. Only accept browser
 * traffic from the page we serve (or localhost), so a random website can't
 * talk to the board or the agent tools behind your back.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin).hostname;
    const host = (req.headers.host ?? "").split(":")[0];
    return o === "localhost" || o === "127.0.0.1" || o === "[::1]" || o === host;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

/** View registry for the board UI (the agent uses the MCP tools instead). */
async function handleViews(req: IncomingMessage, res: ServerResponse, name: string | undefined) {
  if (req.method === "GET" && !name) return json(res, 200, listViews());
  if (req.method === "POST" && !name) {
    try {
      const saved = saveView((await readBody(req)) as Parameters<typeof saveView>[0]);
      notifyRegistryChanged();
      return json(res, 200, saved);
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (req.method === "DELETE" && name) {
    const ok = deleteView(name);
    if (ok) notifyRegistryChanged();
    return json(res, ok ? 200 : 404, { ok });
  }
  json(res, 405, { error: "method not allowed" });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end("Stateless MCP endpoint: POST only");
    return;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400).end("Invalid JSON");
    return;
  }
  // Stateless: a fresh server per request. Board state lives in the Board registry.
  // SSE responses keep long waits (wait_for_changes) alive with keep-alive frames.
  // Agents on this machine may hand over files by path; LAN clients may not.
  const ip = req.socket.remoteAddress ?? "";
  const server = createMcpServer({ local: ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const abort = new AbortController();
  res.on("close", () => {
    abort.abort();
    void transport.close();
    void server.close();
  });
  await server.connect(transport);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: "POST",
    headers,
    signal: abort.signal,
  });
  const response = await transport.handleRequest(request, { parsedBody: body });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of response.body) res.write(chunk);
  } catch {
    // client went away
  }
  res.end();
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Sinapsi server attivo. In sviluppo apri la lavagna su http://localhost:5180 (pnpm dev).");
    return;
  }
  let file = normalize(join(WEB_DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!originAllowed(req)) {
    res.writeHead(403).end("Origin not allowed");
    return;
  }
  // The dev UI runs on another port: allow it (and LAN pages of this same host) to call the API.
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  try {
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    const views = /^\/api\/views(?:\/([\w-]+))?\/?$/.exec(url.pathname);
    if (views) return await handleViews(req, res, views[1]);
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end(String(err));
  }
});

const wss = new WebSocketServer({ noServer: true });

http.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const [, channel, board] = url.pathname.split("/");
  if (!originAllowed(req) || !board || (channel !== "yjs" && channel !== "rpc")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const name = decodeURIComponent(board);
    if (channel === "yjs") getBoard(name).room.connect(ws);
    else registerRenderer(name, ws);
  });
});

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
}

http.listen(PORT, HOST, () => {
  console.log(`\n  ✳ Sinapsi server  http://${HOST}:${PORT}`);
  if (HOST === "0.0.0.0") {
    for (const ip of lanAddresses()) console.log(`    In rete          http://${ip}:5180 (dev) · http://${ip}:${PORT} (build)`);
    console.log("    ⚠ Nessuna autenticazione: chiunque in questa rete può modificare la lavagna.");
  }
  console.log(`    MCP endpoint     http://${HOST}:${PORT}/mcp`);
  console.log(`    Claude Code      claude mcp add --transport http sinapsi http://localhost:${PORT}/mcp\n`);
});
