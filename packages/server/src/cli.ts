/**
 * `livingboard` command line.
 *
 *   livingboard mcp                stdio MCP server for Claude Code (the bridge)
 *   livingboard install [--lan]    /whiteboard skill + MCP bridge + prompt hook, for every project
 *   livingboard uninstall
 *   livingboard start [--lan]      the server in the foreground (boards without Claude Code)
 *
 * The bridge is what Claude Code starts in a project folder. It answers the
 * tool list by itself (so it costs nothing until used), and on the first tool
 * call starts the shared Livingboard server if needed and forwards every call to
 * it, telling it which project folder it works for.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BUNDLED, DATA_DIR, PORT, readServerPort, VERSION, WEB_DIST } from "./config";
import { createMcpServer } from "./mcp";

const SERVER_DIR = resolve(import.meta.dirname, "..");
const REPO = resolve(SERVER_DIR, "..", "..");
/** Where the server is: the port it wrote in server.json (it moves when 3333 is taken), else the default. */
const base = () => `http://127.0.0.1:${readServerPort() ?? PORT}`;
const log = (...a: unknown[]) => console.error("[livingboard]", ...a);
// Through the package's own node_modules link (not the store path): survives reinstalls.
const TSX = pathToFileURL(join(SERVER_DIR, "node_modules", "tsx", "dist", "loader.mjs")).href;

/**
 * How to run a part with node: the bundled files of the npm package (all in `dist/`,
 * next to this one) or the TypeScript sources through tsx.
 */
function nodeArgs(part: "cli" | "server"): string[] {
  if (BUNDLED) return [join(import.meta.dirname, `${part}.js`)];
  return ["--import", TSX, join(SERVER_DIR, "src", part === "cli" ? "cli.ts" : "index.ts")];
}

// ------------------------------------------------------------------ project

/**
 * The project a session works in: the nearest folder (from where Claude Code
 * runs) that already has Livingboard boards, else the git root, else the folder itself.
 * Keep in sync with `bin/livingboard-hook.mjs`.
 */
function projectRoot(start: string): string {
  const up = (dir: string, marker: string): string | null => {
    for (let d = resolve(dir); ; d = dirname(d)) {
      if (existsSync(join(d, marker))) return d;
      if (dirname(d) === d) return null;
    }
  };
  return process.env.LIVINGBOARD_PROJECT || up(start, ".livingboard") || up(start, ".sinapsi") || up(start, ".git") || resolve(start);
}

// ------------------------------------------------------------------ server

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1000) });
    return ((await r.json()) as { app?: string }).app === "livingboard";
  } catch {
    return false;
  }
}

let starting: Promise<void> | null = null;

/** Start the shared server (detached: it outlives this session) unless it already runs. */
function ensureServer(): Promise<void> {
  starting ??= (async () => {
    if (await healthy()) return;
    mkdirSync(DATA_DIR, { recursive: true });
    const logFile = join(DATA_DIR, "server.log");
    const out = openSync(logFile, "a");
    const child = spawn(process.execPath, nodeArgs("server"), {
      cwd: BUNDLED ? DATA_DIR : SERVER_DIR,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    log(`server started (pid ${child.pid}), log in ${logFile}`);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await healthy()) return;
    }
    throw new Error(`The Livingboard server does not answer on ${base()}: see ${logFile}.`);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

// ------------------------------------------------------------------ bridge

async function bridge() {
  const root = projectRoot(process.cwd());

  // Tool list, prompts and instructions come from the same code the server runs,
  // in process: Claude Code sees the tools before any server is up. Instructions
  // are the brief version (every session pays for them); open_board returns the rules.
  const catalog = new Client({ name: "livingboard-catalog", version: VERSION });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ local: true, brief: true }).connect(a);
  await catalog.connect(b);
  const instructions = catalog.getInstructions();

  let remote: Client | null = null;
  const connect = async () => {
    await ensureServer();
    const c = new Client({ name: "livingboard-bridge", version: VERSION });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), {
        requestInit: { headers: { "x-livingboard-project": encodeURIComponent(root) } },
      }),
    );
    return c;
  };

  const server = new Server({ name: "livingboard", version: VERSION }, { capabilities: { tools: {}, prompts: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, () => catalog.listTools());
  server.setRequestHandler(ListPromptsRequestSchema, () => catalog.listPrompts());
  server.setRequestHandler(GetPromptRequestSchema, (req) => catalog.getPrompt(req.params));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    // wait_for_changes may wait minutes; Claude Code has its own limit anyway.
    const opts = { signal: extra.signal, timeout: 30 * 60_000 };
    for (let attempt = 0; ; attempt++) {
      try {
        remote ??= await connect();
        return await remote.callTool(req.params, undefined, opts);
      } catch (err) {
        if (extra.signal.aborted) throw err;
        // The server went away (restarted, closed): start it again and retry once.
        remote = null;
        if (attempt > 0 || (await healthy())) {
          return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
        }
      }
    }
  });

  await server.connect(new StdioServerTransport());
  log(`MCP bridge ready · project ${root}`);
}

// ------------------------------------------------------------------ install

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const SKILL_DIR = join(CLAUDE_DIR, "skills", "whiteboard");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const HOOK = BUNDLED ? join(import.meta.dirname, "livingboard-hook.mjs") : join(SERVER_DIR, "bin", "livingboard-hook.mjs");
const HOOK_MARK = "livingboard-hook.mjs";

const SKILL = `---
name: whiteboard
description: Opens this project's Livingboard whiteboard (a shared whiteboard that acts as the project's living prompt) and works on it. Use it when the user types /whiteboard [name] or asks to open, look at or use the whiteboard.
argument-hint: "[name]"
---

Open this project's Livingboard whiteboard "$ARGUMENTS" (if the name is empty: "main").

1. Call the \`open_board\` tool of the \`livingboard\` MCP server with \`board\` = the name. If the livingboard tools are not loaded yet, search for them (ToolSearch "livingboard").
2. Tell the user in one line where to find it: the URL and, if present, the \`lan\` addresses for tablets. If \`otherBoards\` is not empty, mention them.
3. Read \`rules\` in the \`open_board\` response: they are the working rules for the board and apply for the whole session. Then call \`board_overview\` with the same \`board\` and follow its policy too.
4. From now on the board is the project's living prompt: when you build or change something, update your drawings (\`replace\`, \`erase\`). If a message's context reports changes on the board, read them with \`wait_for_changes\` (\`timeoutSec\`: 1) before answering.
5. If the user wants you to keep listening, enter the loop \`wait_for_changes\` → \`interpret\` → act → \`wait_for_changes\`.

Always use the same \`board\` in every call.
`;

function run(cmd: string, args: string[], quiet = false) {
  const r = spawnSync(cmd, args, { stdio: quiet ? "pipe" : "inherit", shell: process.platform === "win32" && cmd !== "claude", encoding: "utf8" });
  return r.status === 0;
}

function readSettings(): Record<string, unknown> {
  return existsSync(SETTINGS) ? (JSON.parse(readFileSync(SETTINGS, "utf8")) as Record<string, unknown>) : {};
}

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };

/** Our UserPromptSubmit entry, added once (or removed), leaving every other hook alone. */
function setHook(on: boolean) {
  const s = readSettings();
  const hooks = (s.hooks ?? {}) as Record<string, HookEntry[]>;
  const list = (hooks.UserPromptSubmit ?? []).filter((e) => !e.hooks?.some((h) => h.command?.includes(HOOK_MARK)));
  // The data folder tells the hook where to find server.json (the server's port).
  if (on) list.push({ hooks: [{ type: "command", command: `node "${HOOK}" "${DATA_DIR}"`, timeout: 5 }] });
  if (list.length) hooks.UserPromptSubmit = list;
  else delete hooks.UserPromptSubmit;
  s.hooks = hooks;
  if (existsSync(SETTINGS)) writeFileSync(`${SETTINGS}.livingboard-bak`, readFileSync(SETTINGS));
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS, `${JSON.stringify(s, null, 2)}\n`);
}

function install(lan: boolean) {
  if (!run("claude", ["--version"], true)) throw new Error("`claude` command not found: install Claude Code and try again.");

  if (!BUNDLED && !existsSync(WEB_DIST)) {
    console.log("· building the whiteboard page (pnpm build)…");
    if (!run("pnpm", ["--dir", REPO, "build"])) throw new Error("pnpm build failed.");
  }

  // The bridge, for every project (user scope): this same package, by absolute path
  // (no npx on every session start).
  run("claude", ["mcp", "remove", "livingboard", "--scope", "user"], true);
  const env = lan ? ["-e", "LIVINGBOARD_HOST=0.0.0.0"] : [];
  if (!run("claude", ["mcp", "add", "livingboard", "--scope", "user", ...env, "--", "node", ...nodeArgs("cli"), "mcp"])) {
    throw new Error("claude mcp add failed.");
  }
  console.log("✓ MCP server `livingboard` (user scope, started by Claude Code in the project folder)");

  mkdirSync(SKILL_DIR, { recursive: true });
  writeFileSync(join(SKILL_DIR, "SKILL.md"), SKILL);
  console.log(`✓ skill /whiteboard in ${SKILL_DIR}`);

  setHook(true);
  console.log(`✓ UserPromptSubmit hook in ${SETTINGS} (previous copy: settings.json.livingboard-bak)`);

  console.log(`
Done. In any project, in a new Claude Code session:
  /whiteboard          the project's "main" board
  /whiteboard ui       another board of the same project
Boards are saved in the project, in .livingboard/boards/ (with a readable .md copy of each).${lan ? "\nThe server will be visible on the network: pair a tablet with the QR code in the board's Settings." : ""}
Note: where a project or local "livingboard" MCP server already exists (e.g. the old HTTP one), that one wins: remove it with claude mcp remove livingboard.`);
}

function uninstall() {
  run("claude", ["mcp", "remove", "livingboard", "--scope", "user"]);
  rmSync(SKILL_DIR, { recursive: true, force: true });
  if (existsSync(SETTINGS)) setHook(false);
  console.log("✓ removed the MCP server, /whiteboard skill and hook. Boards in projects (.livingboard/) stay.");
}

/** The server in the foreground, for using boards without Claude Code (Ctrl+C stops it). */
function start(lan: boolean) {
  const env = lan ? { ...process.env, LIVINGBOARD_HOST: "0.0.0.0" } : process.env;
  const child = spawn(process.execPath, nodeArgs("server"), { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ------------------------------------------------------------------ main

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "mcp") await bridge();
  else if (cmd === "install") install(rest.includes("--lan"));
  else if (cmd === "uninstall") uninstall();
  else if (cmd === "start") start(rest.includes("--lan"));
  else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
  else {
    console.log("usage: livingboard install [--lan] | uninstall | start [--lan] | mcp | --version");
    process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
