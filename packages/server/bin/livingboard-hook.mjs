#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook (installed by `livingboard install`).
 *
 * Before each prompt, asks the Livingboard server what changed on this project's
 * open boards since the last prompt of this session, and adds one line of
 * context if anything did. Plain JavaScript and no imports beyond Node: it
 * runs on every prompt, in every project, so it must be quick and silent.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The server writes its port in <data folder>/server.json (`livingboard install` passes the folder). */
function serverPort() {
  if (process.env.LIVINGBOARD_PORT) return Number(process.env.LIVINGBOARD_PORT);
  try {
    if (process.argv[2]) return JSON.parse(readFileSync(join(process.argv[2], "server.json"), "utf8")).port ?? 3333;
  } catch {
    // no server.json yet: the default port
  }
  return 3333;
}

/** Nearest folder with Livingboard boards (the bridge saved them there). Mirrors `projectRoot` in src/cli.ts. */
function boardsRoot(start) {
  if (process.env.LIVINGBOARD_PROJECT) return process.env.LIVINGBOARD_PROJECT;
  for (let d = resolve(start); ; d = dirname(d)) {
    // `.sinapsi`: projects from before the rename (the server moves them on first use).
    if (existsSync(join(d, ".livingboard", "boards")) || existsSync(join(d, ".sinapsi", "boards"))) return d;
    if (dirname(d) === d) return null;
  }
}

function plural(n, one, many) {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { cwd, session_id: session } = JSON.parse(input || "{}");
  const root = boardsRoot(cwd || process.cwd());
  if (!root) return;

  let digest;
  try {
    const r = await fetch(`http://127.0.0.1:${serverPort()}/api/digest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, session }),
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return;
    digest = await r.json();
  } catch {
    return; // server off: nothing can have changed
  }

  for (const b of digest.boards ?? []) {
    const parts = [
      b.approvals && plural(b.approvals, "answer to a permission request", "answers to permission requests"),
      b.ideas && plural(b.ideas, "new or changed idea", "new or changed ideas"),
      b.links && plural(b.links, "link", "links"),
      b.drawingEdits && plural(b.drawingEdits, "edit to your drawings", "edits to your drawings"),
      b.feedback && plural(b.feedback, "reply or correction", "replies or corrections"),
      b.removed && plural(b.removed, "deleted item", "deleted items"),
    ].filter(Boolean);
    console.log(
      `Livingboard · changes on this project's board "${b.board}": ${parts.join(", ")}. ` +
        `If they bear on the request, read them with wait_for_changes(board: "${b.board}", timeoutSec: 1) before answering (if you have not opened it in this session yet, call open_board first: it gives you the rules), and keep board and project in sync.`,
    );
  }
}

main().catch(() => {});
