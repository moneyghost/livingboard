/**
 * Tiny MCP client for poking the board from a terminal (or from an agent
 * without native MCP support).
 *
 *   tsx scripts/mcp.ts list
 *   tsx scripts/mcp.ts call board_overview
 *   tsx scripts/mcp.ts call get_board_image '{"nodeIds":["c_x"]}' --out ./shots
 *   tsx scripts/mcp.ts call interpret @reading.json   (args from a file)
 *
 * Images are written to --out (default: current dir) and their paths printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.LIVINGBOARD_MCP ?? "http://localhost:3333/mcp";
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args.splice(outIdx, 2)[1] : ".");
const [cmd, tool, rawArgs] = args;

const client = new Client({ name: "livingboard-cli", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

if (cmd === "list") {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name.padEnd(18)} ${t.description?.split("\n")[0]}`);
} else if (cmd === "call" && tool) {
  const res = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs.startsWith("@") ? readFileSync(rawArgs.slice(1), "utf8") : rawArgs) : {} }, undefined, {
    timeout: 10 * 60_000,
  });
  for (const part of res.content as { type: string; text?: string; data?: string; mimeType?: string }[]) {
    if (part.type === "text") console.log(part.text);
    else if (part.type === "image" && part.data) {
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `${tool}-${Date.now()}.png`);
      writeFileSync(file, Buffer.from(part.data, "base64"));
      console.log(`[image] ${file}`);
    }
  }
  if (res.isError) process.exitCode = 1;
} else {
  console.log("usage: mcp.ts list | call <tool> [json-args] [--out dir]");
}
await client.close();
