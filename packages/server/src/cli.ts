/**
 * `livingboard` command line.
 *
 *   livingboard mcp                stdio MCP server for Claude Code (the bridge)
 *   livingboard install [--lan]    /whiteboard skill + MCP bridge + prompt hook, for every project
 *   livingboard uninstall
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
import { DATA_DIR, PORT, WEB_DIST } from "./config";
import { createMcpServer } from "./mcp";

const SERVER_DIR = resolve(import.meta.dirname, "..");
const REPO = resolve(SERVER_DIR, "..", "..");
const BASE = `http://127.0.0.1:${PORT}`;
const VERSION = "0.1.0";
const log = (...a: unknown[]) => console.error("[livingboard]", ...a);
// Through the package's own node_modules link (not the store path): survives reinstalls.
const TSX = pathToFileURL(join(SERVER_DIR, "node_modules", "tsx", "dist", "loader.mjs")).href;

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
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
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
    const child = spawn(process.execPath, ["--import", TSX, join(SERVER_DIR, "src", "index.ts")], {
      cwd: SERVER_DIR,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    log(`server avviato (pid ${child.pid}), log in ${logFile}`);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await healthy()) return;
    }
    throw new Error(`Il server Livingboard non risponde su ${BASE}: guarda ${logFile} (porta ${PORT} occupata?).`);
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
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
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
  log(`ponte MCP pronto · progetto ${root}`);
}

// ------------------------------------------------------------------ install

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const SKILL_DIR = join(CLAUDE_DIR, "skills", "whiteboard");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const HOOK = join(SERVER_DIR, "bin", "livingboard-hook.mjs");
const HOOK_MARK = "livingboard-hook.mjs";

const SKILL = `---
name: whiteboard
description: Apre la lavagna Livingboard di questo progetto (lavagna condivisa che fa da prompt vivo del progetto) e ci lavora sopra. Usala quando l'utente scrive /whiteboard [nome] o chiede di aprire, guardare o usare la lavagna.
argument-hint: "[nome]"
---

Apri la lavagna Livingboard "$ARGUMENTS" di questo progetto (se il nome è vuoto: "main").

1. Chiama il tool \`open_board\` del server MCP \`livingboard\` con \`board\` = il nome. Se i tool di livingboard non sono ancora caricati, cercali (ToolSearch "livingboard").
2. Di' all'utente in una riga dove la trova: l'URL e, se ci sono, gli indirizzi \`lan\` per tablet. Se \`otherBoards\` non è vuoto, nominale.
3. Leggi \`rules\` nella risposta di \`open_board\`: sono le regole di lavoro sulla lavagna e valgono per tutta la sessione. Poi chiama \`board_overview\` con lo stesso \`board\` e segui anche la sua policy.
4. Da qui la lavagna è il prompt vivo del progetto: quando costruisci o cambi qualcosa, aggiorna i tuoi disegni (\`replace\`, \`erase\`). Se il contesto di un messaggio segnala novità sulla lavagna, leggile con \`wait_for_changes\` (\`timeoutSec\`: 1) prima di rispondere.
5. Se l'utente vuole che resti in ascolto, entra nel ciclo \`wait_for_changes\` → \`interpret\` → agisci → \`wait_for_changes\`.

Usa sempre lo stesso \`board\` in tutte le chiamate.
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
  if (on) list.push({ hooks: [{ type: "command", command: `node "${HOOK}"`, timeout: 5 }] });
  if (list.length) hooks.UserPromptSubmit = list;
  else delete hooks.UserPromptSubmit;
  s.hooks = hooks;
  if (existsSync(SETTINGS)) writeFileSync(`${SETTINGS}.livingboard-bak`, readFileSync(SETTINGS));
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS, `${JSON.stringify(s, null, 2)}\n`);
}

function install(lan: boolean) {
  if (!run("claude", ["--version"], true)) throw new Error("Comando `claude` non trovato: installa Claude Code e riprova.");

  if (!existsSync(WEB_DIST)) {
    console.log("· costruisco la pagina della lavagna (pnpm build)…");
    if (!run("pnpm", ["--dir", REPO, "build"])) throw new Error("pnpm build non riuscito.");
  }

  // The bridge, for every project (user scope). `node --import tsx` runs the TypeScript sources.
  run("claude", ["mcp", "remove", "livingboard", "--scope", "user"], true);
  const env = lan ? ["-e", "LIVINGBOARD_HOST=0.0.0.0"] : [];
  const cli = join(SERVER_DIR, "src", "cli.ts");
  if (!run("claude", ["mcp", "add", "livingboard", "--scope", "user", ...env, "--", "node", "--import", TSX, cli, "mcp"])) {
    throw new Error("claude mcp add non riuscito.");
  }
  console.log("✓ server MCP `livingboard` (scope utente, avviato da Claude Code nella cartella del progetto)");

  mkdirSync(SKILL_DIR, { recursive: true });
  writeFileSync(join(SKILL_DIR, "SKILL.md"), SKILL);
  console.log(`✓ skill /whiteboard in ${SKILL_DIR}`);

  setHook(true);
  console.log(`✓ hook UserPromptSubmit in ${SETTINGS} (copia di prima: settings.json.livingboard-bak)`);

  console.log(`
Fatto. In qualsiasi progetto, in una nuova sessione di Claude Code:
  /whiteboard          lavagna "main" del progetto
  /whiteboard ui       un'altra lavagna dello stesso progetto
Le lavagne si salvano nel progetto, in .livingboard/boards/.${lan ? "\nIl server sarà visibile in rete (tablet): nessuna autenticazione." : ""}
Nota: dove esiste già un server MCP "livingboard" di progetto o locale (es. vecchio HTTP), vince quello: toglilo con claude mcp remove livingboard.`);
}

function uninstall() {
  run("claude", ["mcp", "remove", "livingboard", "--scope", "user"]);
  rmSync(SKILL_DIR, { recursive: true, force: true });
  if (existsSync(SETTINGS)) setHook(false);
  console.log("✓ rimossi server MCP, skill /whiteboard e hook. Le lavagne nei progetti (.livingboard/) restano.");
}

// ------------------------------------------------------------------ main

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "mcp") await bridge();
  else if (cmd === "install") install(rest.includes("--lan"));
  else if (cmd === "uninstall") uninstall();
  else {
    console.log("uso: livingboard mcp | install [--lan] | uninstall");
    process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
