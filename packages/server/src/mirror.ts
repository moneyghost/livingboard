import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Board } from "./board";

/**
 * A readable copy of a board, saved next to its `.ydoc` (`.livingboard/boards/<name>.md`):
 * what the board says, in plain Markdown. It shows up in diffs and pull requests and
 * any agent can read it without the MCP server. Generated, never read back: the board
 * stays the source. Stable order and no timestamps, so it changes only when the board does.
 */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.map(fmt).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function boardMarkdown(b: Board): string {
  const out: string[] = [];
  out.push(`# ${b.label}`, "");
  out.push(`> Livingboard board of ${b.project.name}, written by Livingboard on every change: edit the board, not this file (\`/whiteboard ${b.label}\` in Claude Code).`, "");

  const sections = [...b.docSections.values()].sort((x, y) => x.order - y.order || x.id.localeCompare(y.id));
  if (sections.length) {
    out.push("## Document", "");
    for (const s of sections) out.push(`### ${s.title}`, "", s.markdown.trim(), "");
  }

  const nodes = [...b.nodes.values()].filter((n) => n.status !== "rejected");
  const label = (id: string) => b.nodes.get(id)?.label ?? id;
  if (nodes.length) {
    out.push("## Ideas", "");
    const types = [...new Set(nodes.map((n) => n.type))].sort();
    const edges = [...b.edges.values()].filter((e) => e.status !== "rejected");
    for (const type of types) {
      const desc = b.ontology.get(type)?.description;
      out.push(`### ${type}${desc ? ` — ${oneLine(desc)}` : ""}`, "");
      for (const n of nodes.filter((x) => x.type === type).sort((x, y) => x.label.localeCompare(y.label))) {
        out.push(`- **${oneLine(n.label)}**${n.summary ? `: ${oneLine(n.summary)}` : ""}`);
        const props = Object.entries(n.props);
        if (props.length) out.push(`  - ${props.map(([k, v]) => `${k}: ${clip(oneLine(fmt(v)), 80)}`).join(" · ")}`);
        for (const e of edges.filter((x) => x.from === n.id).sort((x, y) => x.type.localeCompare(y.type))) {
          out.push(`  - ${e.type} → ${oneLine(label(e.to))}${e.label ? ` (${oneLine(e.label)})` : ""}`);
        }
        if (n.assumptions.length) out.push(`  - assumes: ${n.assumptions.map(oneLine).join("; ")}`);
        if (n.build?.state === "done" && n.build.files?.length) out.push(`  - built: ${n.build.files.join(", ")}`);
      }
      out.push("");
    }
  }

  // Things people drew that nobody has read yet: their words are already worth having.
  const unread = [...b.candidates.values()]
    .filter((c) => c.kind !== "link" && !b.nodes.has(c.id) && c.texts.some((t) => t.trim()))
    .map((c) => clip(oneLine(c.texts.join(" / ")), 200))
    .sort();
  if (unread.length) {
    out.push("## Not read yet", "", ...unread.map((t) => `- ${t}`), "");
  }

  const drawings = b.drawings().sort((x, y) => (x.title ?? x.drawingId).localeCompare(y.title ?? y.drawingId));
  if (drawings.length) {
    out.push("## Claude's drawings", "");
    for (const d of drawings) {
      const texts = clip(oneLine(d.texts.join(" · ")), 300);
      out.push(`- **${oneLine(d.title ?? d.kind ?? "drawing")}**${d.kind ? ` (${d.kind})` : ""}${texts ? `: ${texts}` : ""}`);
    }
    out.push("");
  }

  if (out.length <= 4) out.push("_The board is empty._", "");
  return `${out.join("\n").trimEnd()}\n`;
}

/** Skip the write when nothing changed (no churn in git, no file watchers woken up). */
export function writeIfChanged(file: string, text: string) {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  writeFileSync(file, text);
}
