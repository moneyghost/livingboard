#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook (installed by `sinapsi install`).
 *
 * Before each prompt, asks the Sinapsi server what changed on this project's
 * open boards since the last prompt of this session, and adds one line of
 * context if anything did. Plain JavaScript and no imports beyond Node: it
 * runs on every prompt, in every project, so it must be quick and silent.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PORT = Number(process.env.SINAPSI_PORT ?? 3333);

/** Nearest folder with Sinapsi boards (the bridge saved them there). Mirrors `projectRoot` in src/cli.ts. */
function boardsRoot(start) {
  if (process.env.SINAPSI_PROJECT) return process.env.SINAPSI_PROJECT;
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, ".sinapsi", "boards"))) return d;
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
    const r = await fetch(`http://127.0.0.1:${PORT}/api/digest`, {
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
      b.ideas && plural(b.ideas, "idea nuova o cambiata", "idee nuove o cambiate"),
      b.links && plural(b.links, "collegamento", "collegamenti"),
      b.drawingEdits && plural(b.drawingEdits, "tuo disegno modificato", "tuoi disegni modificati"),
      b.feedback && plural(b.feedback, "risposta o correzione", "risposte o correzioni"),
      b.removed && plural(b.removed, "cosa cancellata", "cose cancellate"),
    ].filter(Boolean);
    console.log(
      `Sinapsi · novità sulla lavagna "${b.board}" di questo progetto: ${parts.join(", ")}. ` +
        `Se c'entrano con la richiesta, leggile con wait_for_changes(board: "${b.board}", timeoutSec: 1) prima di rispondere (se in questa sessione non l'hai ancora aperta, prima open_board: ti dà le regole), e tieni lavagna e progetto allineati.`,
    );
  }
}

main().catch(() => {});
