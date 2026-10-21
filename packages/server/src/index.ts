import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { extname, join, normalize } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebSocketServer } from "ws";
import { getBoard, notifyRegistryChanged, openBoardsOf } from "./board";
import { BUNDLED, DATA_DIR, DEFAULT_PORT, DEV, HOST, lanAddresses, PORT, PORT_PINNED, SERVER_INFO, setPort, WEB_DIST } from "./config";
import { authorized, isLocal, LAN, lanToken, resetLanToken, tokenCookie, validToken } from "./lan";
import { createMcpServer } from "./mcp";
import { getProject, listProjects, parseBoardKey, type Project, registerProject } from "./projects";
import { deleteView, listViews, saveView } from "./registry";
import { registerRenderer } from "./render";


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

/**
 * The bridge (`livingboard mcp`, started by Claude Code inside a project folder)
 * says which project it works for. Only agents on this machine may: the folder
 * is where the server writes that project's boards.
 */
function projectOf(req: IncomingMessage): Project | undefined {
  const root = req.headers["x-livingboard-project"];
  if (typeof root !== "string" || !root || !isLocal(req)) return undefined;
  return registerProject(decodeURIComponent(root));
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
  // Only the bridge on this machine talks MCP: it says which project it works for.
  if (!isLocal(req)) {
    res.writeHead(403).end("MCP is only available on this machine");
    return;
  }
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
  const server = createMcpServer({ local: true, project: projectOf(req) });
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

/**
 * For the Claude Code prompt hook: what changed on the project's open boards
 * since this session last asked, without consuming it (wait_for_changes does).
 */
const digestSeen = new Map<string, string>();
async function handleDigest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST" || !isLocal(req)) return json(res, 403, { error: "local only" });
  const { root, session } = ((await readBody(req)) ?? {}) as { root?: string; session?: string };
  if (!root) return json(res, 400, { error: "root required" });
  const project = registerProject(root);
  const boards = openBoardsOf(project.id)
    .map((b) => ({ board: b.label, ...b.pending() }))
    .filter((p) => p.ideas || p.links || p.feedback || p.removed || p.drawingEdits || p.approvals);
  const sig = boards.map((p) => p.board + p.sig).join("#");
  const seenKey = `${session ?? ""}@${project.id}`;
  const fresh = !!boards.length && digestSeen.get(seenKey) !== sig;
  digestSeen.set(seenKey, sig);
  if (digestSeen.size > 200) digestSeen.delete(digestSeen.keys().next().value!);
  json(res, 200, { project: project.id, boards: fresh ? boards : [] });
}

/** Pairing info for the QR code: other devices open the board with the token once. */
function handleLan(req: IncomingMessage, res: ServerResponse, reset: boolean) {
  if (reset) {
    if (req.method !== "POST" || !isLocal(req)) return json(res, 403, { error: "only on this computer" });
    resetLanToken();
  }
  json(res, 200, LAN ? { enabled: true, port: PORT, addresses: lanAddresses(), token: lanToken() } : { enabled: false, port: PORT });
}

/** Projects with their boards, for the home page. */
function handleProjects(res: ServerResponse) {
  json(
    res,
    200,
    listProjects().map((p) => ({
      ...p,
      boards: [...new Set([...p.boards.map((b) => b.name), ...openBoardsOf(p.id).map((b) => b.label)])]
        .map((name) => ({ name, updatedAt: p.boards.find((b) => b.name === name)?.updatedAt ?? Date.now() }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    })),
  );
}

const LOCKED = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Livingboard</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1f2328;text-align:center;padding:16px">
<div><div style="font-size:2rem;color:#d97757;font-weight:700">✳ Livingboard</div>
<p>This device is not paired yet.</p>
<p style="color:#6b7280">On the computer running Livingboard, open the board, then <b>✳ Claude → Settings → Other devices</b> and scan the QR code.</p></div>`;

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Livingboard server running. In development, open the board at http://localhost:5180 (pnpm dev).");
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
    if (url.pathname === "/api/digest") return await handleDigest(req, res);
    if (url.pathname === "/health") return json(res, 200, { ok: true, app: "livingboard", dev: DEV });
    if (!authorized(req)) {
      // Opened from the QR code: keep the token as a cookie and drop it from the address.
      const t = url.searchParams.get("t");
      if (req.method === "GET" && validToken(t)) {
        url.searchParams.delete("t");
        res.writeHead(302, { "Set-Cookie": tokenCookie(), Location: url.pathname + url.search }).end();
        return;
      }
      if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "not paired" });
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }).end(LOCKED);
      return;
    }
    if (url.pathname === "/api/lan" || url.pathname === "/api/lan/reset") return handleLan(req, res, url.pathname.endsWith("/reset"));
    if (url.pathname === "/api/projects") return handleProjects(res);
    const views = /^\/api\/views(?:\/([\w-]+))?\/?$/.exec(url.pathname);
    if (views) return await handleViews(req, res, views[1]);
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
  let key = "";
  try {
    key = decodeURIComponent(board ?? "");
  } catch {
    // malformed: refused below
  }
  // Boards belong to projects: one opens only if a local agent registered its project.
  const k = parseBoardKey(key);
  if (!originAllowed(req) || !authorized(req) || !k.projectId || !getProject(k.projectId) || (channel !== "yjs" && channel !== "rpc")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (channel === "yjs") getBoard(key).room.connect(ws);
    else registerRenderer(key, ws);
  });
});

/**
 * Another program may hold the port (3333 is also AdonisJS's default): move to the next
 * free one and say where in server.json, which the bridge and the hook read. If the
 * holder is another Livingboard server, this one is not needed. The port is probed
 * before listening because Windows lets an IPv4 and an IPv6 server share it silently.
 */
async function probe(port: number): Promise<"free" | "livingboard" | "other"> {
  for (const host of ["127.0.0.1", "::1"]) {
    const open = await new Promise<boolean>((done) => {
      const sock = connect({ host, port });
      sock.setTimeout(500, () => {
        sock.destroy();
        done(false);
      });
      sock.once("connect", () => {
        sock.destroy();
        done(true);
      });
      sock.once("error", () => done(false));
    });
    if (!open) continue;
    try {
      const r = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}/health`, { signal: AbortSignal.timeout(1000) });
      return ((await r.json()) as { app?: string }).app === "livingboard" ? "livingboard" : "other";
    } catch {
      return "other";
    }
  }
  return "free";
}

async function listen() {
  for (;;) {
    const state = await probe(PORT);
    if (state === "free") break;
    if (state === "livingboard") {
      console.log(`Livingboard is already running on port ${PORT}.`);
      process.exit(0);
    }
    if (PORT_PINNED || PORT >= DEFAULT_PORT + 20) {
      console.error(`Port ${PORT} is busy: set LIVINGBOARD_PORT to a free port.`);
      process.exit(1);
    }
    setPort(PORT + 1);
  }
  http.listen(PORT, HOST);
}

// Lost a race for the port after probing: probe it again (another Livingboard, or move on).
http.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  void listen();
});

http.on("listening", () => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SERVER_INFO, `${JSON.stringify({ port: PORT, host: HOST, pid: process.pid }, null, 2)}\n`);
  console.log(`\n  ✳ Livingboard server  http://${HOST}:${PORT}`);
  if (LAN) {
    for (const ip of lanAddresses()) console.log(`    Network          http://${ip}:${PORT}/?t=${lanToken()}`);
    console.log("    Other devices open it once with the link above, or with the QR code in the board's Settings.");
  }
  console.log(`    Claude Code      ${BUNDLED ? "livingboard" : "pnpm livingboard"} install, then /whiteboard [name] in any project\n`);
});

void listen();
