/**
 * Talks to the stdio bridge exactly like Claude Code does: starts `cli.ts mcp`
 * in a project folder, lists the tools and calls a few of them.
 *
 *   pnpm --filter @livingboard/server exec tsx scripts/bridge-smoke.ts <project folder> [board]
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const folder = resolve(process.argv[2] ?? ".");
const board = process.argv[3] ?? "main";
const server = resolve(import.meta.dirname, "..");
const tsx = pathToFileURL(join(server, "node_modules", "tsx", "dist", "loader.mjs")).href;

const client = new Client({ name: "bridge-smoke", version: "0.0.0" });
let t = performance.now();
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["--import", tsx, join(server, "src", "cli.ts"), "mcp"], cwd: folder, stderr: "inherit" }),
);
const { tools } = await client.listTools();
console.log(`tools: ${tools.length} in ${Math.round(performance.now() - t)}ms · open_board: ${tools.some((x) => x.name === "open_board")}`);
console.log(`instructions: ${client.getInstructions()?.slice(0, 60)}…`);

const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("\n");

t = performance.now();
console.log(`open_board (${Math.round(performance.now() - t)}ms):`, text(await client.callTool({ name: "open_board", arguments: { board, open: false } })));
console.log(
  "draw_table:",
  text(
    await client.callTool({
      name: "draw_table",
      arguments: { board, title: "Prova ponte", rows: [["Cosa", "Stato"], ["Ponte stdio", "✓"], ["Hook", "⏳"]], header: true },
    }),
  ),
);
const overview = JSON.parse(text(await client.callTool({ name: "board_overview", arguments: { board } })));
console.log("overview.board:", overview.board, "· drawings:", overview.drawings?.length);
await client.close();
