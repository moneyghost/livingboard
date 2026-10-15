# Demo: mod Minecraft dalla lavagna

`frost_golem_BP/` e `frost_golem_RP/` sono stati generati dall'agente leggendo l'esempio della lavagna
(Frost Golem, Frost Shard, Ice Spikes, spada disegnata a mano, ricetta modificata dalla vista interattiva).

Per rifarlo da zero con Claude Code:

1. Avvia Sinapsi dalla radice del repo: `pnpm dev`, poi apri http://localhost:5180.
2. Apri Claude Code in questa cartella: il file `.mcp.json` registra già il server `sinapsi`.
3. In Claude Code: `/mcp__sinapsi__start`.
4. Disegna. Le istruzioni per l'agente sono in `CLAUDE.md`.
