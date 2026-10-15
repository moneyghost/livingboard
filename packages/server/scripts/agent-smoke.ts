/**
 * Scripted stand-in for Claude: listens to the board over MCP and reacts with
 * dumb, deterministic rules. It proves the whole loop (segmentation → attention
 * → MCP → overlay) works without a model. Keep the board open in a browser.
 *
 *   pnpm smoke              # listen forever (Ctrl+C to stop)
 *   pnpm smoke -- --rounds 3
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.SINAPSI_MCP ?? "http://localhost:3333/mcp";
const roundsArg = process.argv.indexOf("--rounds");
const rounds = roundsArg >= 0 ? Number(process.argv[roundsArg + 1]) : Infinity;

type Change = { id: string; kind: string; summary: string; texts: string[] };
type Link = { id: string; label?: string };
type Report = { changes: Change[]; links: Link[]; removed: { id: string }[]; feedback: { kind: string; user: string }[]; idle: boolean };

const client = new Client({ name: "sinapsi-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = (res.content as { type: string; text?: string }[]).find((p) => p.type === "text")?.text ?? "{}";
  if (res.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

/** "App: Meteo in bici" → type "app", label "Meteo in bici". Anything else gets a generic type. */
function guess(c: Change) {
  const first = c.texts[0] ?? "";
  const m = /^([\p{L}][\p{L} ]{0,20}):\s*(.+)/u.exec(first);
  if (m) return { type: m[1].trim().toLowerCase(), label: m[2].split("\n")[0].trim() };
  return { type: c.kind === "sketch" ? "schizzo" : c.kind === "frame" ? "area" : "nota", label: (first || c.summary).split("\n")[0].slice(0, 40) };
}

await call("board_overview");
console.log(`✳ smoke agent collegato a ${url}`);

for (let i = 0; i < rounds; i++) {
  const r = await call<Report>("wait_for_changes", { timeoutSec: 30 });
  if (r.idle) continue;

  const questions = r.changes.filter((c) => c.kind === "question");
  const things = r.changes.filter((c) => c.kind !== "question");
  if (things.length || r.links.length) {
    const out = await call<{ results: string[] }>("interpret", {
      nodes: things.map((c) => ({
        id: c.id,
        ...guess(c),
        summary: `Lettura automatica: ${c.summary}`,
        assumptions: ["Lettura euristica dello smoke test, non di un modello"],
        confidence: 0.5,
      })),
      edges: r.links.map((l) => ({ id: l.id, type: l.label ?? "collegato" })),
    });
    for (const line of out.results) console.log("  interpretato", line);
  }
  for (const q of questions) {
    await call("comment", { nodeId: q.id, kind: "answer", text: `(smoke test) Domanda ricevuta: «${q.texts.join(" ")}». Collega Claude Code per una risposta vera.` });
    console.log("  risposto a", q.id);
  }
  for (const f of r.feedback) console.log(`  feedback ${f.kind} da ${f.user}`);
  for (const x of r.removed) console.log("  rimosso", x.id);
}

await client.close();
