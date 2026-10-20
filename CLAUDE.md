# Sinapsi: note per chi sviluppa

Lavagna collaborativa (Excalidraw + Yjs) letta dall'AI via MCP. Panoramica utente nel README.

## Comandi

- `pnpm dev`: server (porta 3333, tsx watch) + web (Vite, 5180) in parallelo
- `pnpm dev:lan`: uguale ma visibile dalla rete (server con `--lan`, Vite con `--host 0.0.0.0`)
- `pnpm typecheck`: tutti i pacchetti
- `pnpm smoke`: agente finto che esercita il ciclo MCP senza LLM
- `pnpm sinapsi install [--lan]` / `uninstall`: server MCP stdio (scope utente), skill `/whiteboard`, hook `UserPromptSubmit`
- `pnpm --filter @sinapsi/server exec tsx scripts/bridge-smoke.ts <cartella> [lavagna]`: prova il ponte stdio come farebbe Claude Code
- `pnpm --filter @sinapsi/server exec tsx scripts/mcp.ts call <tool> [json|@file]`: client MCP da terminale
- `pnpm --filter @sinapsi/server exec tsx scripts/segment-debug.ts <board> [--svg out.svg]`: segmentazione offline di una lavagna salvata (SVG colorato per gruppo)

## Architettura in breve

- `packages/shared/src/index.ts`: contratto unico. Ogni chiave `DOC.*` è una Y.Map/Y.Array di oggetti JSON sostituiti interi.
- `packages/server/src/segment.ts`: pre-passaggio geometrico puro (elementi → candidati + link). Nessuna semantica.
- `packages/server/src/board.ts`: stato per lavagna, maturazione (attenzione), coda per `wait_for_changes`, cursore AI, persistenza.
- `packages/server/src/mcp.ts`: tool MCP; server stateless, un'istanza per richiesta.
- `packages/web/src/collab.ts`: binding Excalidraw ↔ Y.Map (vince la `version` più alta) + awareness.
- `packages/web/src/Overlay.tsx`: lente AI disegnata sopra il canvas in coordinate schermo.
- `packages/web/src/gestures.ts` + `Dock.tsx`: modalità tablet (dita = navigazione, penna = disegno, tap 2/3 dita = annulla/ripeti).
- `packages/server/src/registry.ts`: registro viste in `data/views/*.json`, esposto su `/api/views` e via MCP.
- `packages/server/src/draw.ts`: tutti i disegni dell'agente (forme, note, annotazioni, scene SVG, tabelle, grafici, immagini, `extend`). Decide sempre il *dove*; max 20 parole per elemento.
- `packages/server/src/svgpath.ts`: SVG → scena (rect, ellipse, line/path con archi, text, frecce da marker, transform dei `<g>`, paint ereditato).
- `packages/web/src/Messages.tsx`: messaggi di Claude sulla lavagna (fumetti aperti finché letti, segno ✳, casella in alto); "letto" in localStorage per dispositivo.
- `packages/shared/src/layout.ts`: riordino ad albero condiviso da server (`propose_layout`) e browser (pulsante Riordina).
- `packages/web/src/Document.tsx`: scheda Documento (sezioni `write_doc` + mappa generata dal grafo).
- `packages/server/src/cli.ts`: `sinapsi mcp` è il ponte stdio che Claude Code avvia nel progetto. Lista dei tool dallo stesso `createMcpServer` in memoria (nessun server serve per vederli); alla prima chiamata avvia il server staccato (`data/server.log`) e inoltra su `/mcp` con l'header `x-sinapsi-project` (cartella). Annuncia solo istruzioni brevi (`BRIEF_INSTRUCTIONS`: le paga ogni sessione di ogni progetto); le regole complete (`INSTRUCTIONS`) arrivano in `open_board.rules`. Qui anche `install`/`uninstall`.
- `packages/server/src/projects.ts`: progetti (id = nome cartella + hash del percorso, in `data/projects.json`) e chiavi delle lavagne: `main` (globale) o `<id>:<nome>` (file in `<progetto>/.sinapsi/boards/`). `Board.name` è la chiave (websocket, render), `Board.label` il nome per persone e agente.
- `packages/server/bin/sinapsi-hook.mjs`: hook `UserPromptSubmit`, JavaScript semplice senza dipendenze (gira a ogni prompt in ogni progetto); chiede `/api/digest`, che conta le novità con `Board.pending()` senza consumarle e non ripete la stessa novità nella stessa sessione.
- `packages/server/src/image.ts`: caricamento immagini per `add_image` (riconoscimento dai byte, dimensioni dall'header, id = sha1 come Excalidraw).

## Insidie note

- Variabili d'ambiente del server: `SINAPSI_PORT` / `SINAPSI_HOST` (non `PORT`: i launcher la impostano per Vite). `SINAPSI_PROJECT` forza la cartella del progetto per ponte e hook; `SINAPSI_WEB_URL` l'indirizzo della pagina.
- `pnpm dev` passa `--dev` al server: `open_board` punta a Vite (5180) invece che alla build (3333). Se il ponte ha già avviato il server, `pnpm dev` trova la porta 3333 occupata: chiudi quel processo prima.
- Il ponte stdio non deve scrivere su stdout (è il canale MCP): log solo su stderr.
- Sync Yjs scritto a mano in `yserver.ts`: `@y/websocket-server` richiede yjs 14.
- Excalidraw colora i cursori remoti con un hash dell'`id`: "claude-52" dà l'arancione dell'AI.
- `excalidrawAPI` viene chiamato nel costruttore di Excalidraw: salvarlo con `queueMicrotask`.
- Testo libero vicino al centro di una freccia = etichetta della freccia (altrimenti un box lo ingloba e la freccia perde un estremo).
- Tratti a mano: i "fili" (tratti lunghi e diritti, o lunghi e sciolti ma non chiusi) restano fuori dal clustering e poi diventano link, decorazioni o unioni (`runsAlong`). Le soglie sono in testa a `segment.ts`: ritarale con `segment-debug.ts` su un disegno vero prima di cambiarle.
- Gruppi espliciti (`DOC.groups`, umani o AI) = must-link + cannot-link nel union-find; un elemento sta in un solo gruppo.
- Un ID di candidato si riusa solo se la nuova versione contiene almeno metà degli elementi: dopo una divisione ogni parte è nuova e l'interpretazione vecchia viene scartata.
- MCP: si usa `WebStandardStreamableHTTPServerTransport` con piping manuale; il wrapper Node dell'SDK corrompeva il chunked encoding.
- Excalidraw, una volta montato, resetta la scena con `initialData`: la lavagna si carica passando gli elementi della prima sync Yjs come `initialData`, non con `updateScene`.
- Un indice frazionario malformato blocca il caricamento di tutti i client: `collab.ts` e `draw.ts` scartano gli indici non validi.
- Testi tagliati: un testo misurato prima che Excalifont sia caricato tiene la larghezza del font sostitutivo e il canvas lo taglia (Safari non carica i font da solo per il canvas). `collab.ts` (`fitText`) carica i glifi dei testi arrivati dal server e li rimisura in locale, senza cambiare `version`.
- Niente indicatori animati per elemento sul canvas (scelta dell'utente): lo stato dell'AI va nel pannello.
- In dev `window.__excalidraw` e `window.__collab` sono esposti per il debug.
- Nessuna logica di dominio nel nucleo (server, web, shared): niente Minecraft o simili. Il dominio sta nell'agente e nella sua cartella; `demo/` è solo un esempio d'uso.
- Immagini: i dati stanno in `DOC.files` (fileId → BinaryFileData), gli elementi portano solo il `fileId`. Il browser condivide solo i file usati da immagini vive (Excalidraw tiene in memoria anche quelli vecchi); il server cancella il file sostituito da `replace` e all'avvio quelli che nessun elemento usa.
- `add_image` con `path` funziona solo per client MCP in loopback (`createMcpServer({ local })`): in `--lan` l'endpoint MCP è raggiungibile dalla rete.
- Mermaid → Excalidraw gira nel browser (`rpc.ts`, import dinamico di `@excalidraw/mermaid-to-excalidraw`): `draw_diagram` richiede una lavagna aperta, come `get_board_image`.
- I disegni AI legati a un nodo hanno `customData.sinapsi.nodeId`: seguono il nodo nel riordino e ne allargano l'ingombro (`footprint`).
- L'hash di un candidato è sul *contenuto* degli elementi, non sulla posizione: spostare non fa rileggere nulla (`HASH_VERSION` in `board.ts` migra le lavagne vecchie).
- Piazzamento (`Drawer.place`): candidati su una griglia allineata all'ancora, tutto attorno; vince il più economico libero: vicinanza + crescita del perimetro della lavagna + distanza dalla forma schermo (contro le strisce) + lieve preferenza destra/sotto; le parti di una chiamata senza `near` restano un gruppo compatto. Senza ancora il riferimento è `focus()`: gli ultimi elementi umani toccati (`updated`). Le note vanno nel posto libero più vicino al nodo, non più nel margine.
- Disposizione dei disegni AI (`draw.ts`): le frecce esistenti sono percorsi (`lines`), non rettangoli; `extend` valuta ventaglio/pettine a più distanze con un punteggio (sovrapposizioni, frecce sul testo, incroci, distanza) e tiene frecce dritte o ad angolo; `route()` (frecce di `draw`) prova dritta, curva, angolo.
- Lavagna pulita di default: lente spenta (`sinapsi:lens`), etichetta solo sull'idea selezionata, sulla scheda aperta e sulle proposte in modalità ibrida. Fumetti ed etichette evitano frecce, disegni AI e altri nodi (`cost()` in `Overlay.tsx`).
- Lente AI accesa: sotto zoom 0.5 solo titoli grandi; etichette delle relazioni da 0.7 in su; viste solo se aperte (locale) o fissate (`pinned`, condiviso).
- Disegni dell'agente: ogni chiamata di un tool di disegno = un `drawingId` in `customData.sinapsi` (con `kind`, `title`, `nodeId`). `replace` cancella il vecchio e (per svg/tabelle/grafici) mette il nuovo al suo posto; `erase` cancella. `board_overview.drawings` li elenca.
- Modifiche umane ai disegni dell'agente: `board.ts` confronta il contenuto (testi, parti, immagini) a riposo; spostare non conta. Arrivano in `wait_for_changes.drawingEdits` con `added`/`removed`. Le scritture del server (origin `SERVER`) aggiornano solo la base di confronto.
- Permessi disegnati (`DOC.approvals`): una richiesta ricorda gli id delle due caselle e le legge dov'è ora (si può spostare). Segno = elemento umano piccolo con il centro sulla casella (allargata del 40%), fermo da 700ms; vince il più recente. I segni non entrano nella segmentazione (`approvalMarkIds`) e la risposta arriva una volta sola in `approvals` (un ripensamento conta di nuovo).
- `delete_text`: il testo AI va libero; quello umano solo con `approvalId` a Sì, e se la richiesta ha `about` solo dentro quegli elementi. `match` ignora i testi delle richieste di permesso (citano il testo da cancellare).
- Nel pannello browser in background `requestAnimationFrame` non gira: il viewport dell'overlay resta vecchio finché la scheda non è visibile (falso negativo nei test).
