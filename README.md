# ✳ Livingboard

Lavagna collaborativa open source che fa da **prompt vivo** per un progetto costruito con l'AI.

Con un prompt testuale dai un'istruzione, ricevi un risultato, e dopo un'ora di chat la visione d'insieme è persa nello scroll. In Livingboard il prompt è la lavagna: la disegni, Claude la legge, costruisce, e riporta sulla lavagna quello che ha fatto (schermate, tabelle, schemi, screenshot). Persone e Claude la modificano entrambi, nel tempo, e **lavagna e progetto corrispondono sempre**: cambi una cella della tabella di Claude e Claude cambia il progetto; Claude cambia il progetto e aggiorna il disegno.

Il collegamento con l'AI passa da **MCP**, quindi funziona con Claude Code o con qualsiasi client MCP.

> Esempio: disegni un'app con riquadri, frecce e uno schizzo. Claude riconosce funzioni e dati, risponde alle domande `@AI` con un messaggio sulla lavagna, disegna accanto la prima schermata e la tabella degli avvisi, costruisce il progetto nella sua cartella e tiene tutto aggiornato.

**Quando conviene (e quando no).** La lavagna vince quando la posizione è il contenuto (schermate, flussi, mappe, architetture), quando il progetto dura settimane e va capito con un'occhiata, quando si lavora in più persone, quando si confronta o si dà priorità (tabelle, matrici), con penna e tablet. Per bug, refactoring, regole precise e numeri il testo resta più veloce: Livingboard non lo sostituisce, gli dà una mappa.

Livingboard non sa niente di nessun dominio: niente plugin per giochi, app o documenti. Il dominio lo porta l'agente (e la cartella in cui lavora); la lavagna offre solo strumenti generici per leggere, disegnare e mostrare immagini.

## Avvio rapido

Una volta sola, dalla cartella di Livingboard:

```bash
pnpm install
pnpm livingboard install
```

Poi in **qualsiasi progetto**, in una nuova sessione di Claude Code:

```
/whiteboard          la lavagna "main" del progetto
/whiteboard ui       un'altra lavagna dello stesso progetto
```

Claude apre la lavagna nel browser e ci lavora. Non serve avviare niente a mano: il server parte da solo alla prima chiamata e resta acceso per tutti i progetti. Le lavagne di un progetto si salvano **nel progetto**, in `.livingboard/boards/<nome>.ydoc`, così viaggiano e si versionano con il codice. Per il tablet: `pnpm livingboard install --lan` (il server diventa visibile in rete; `open_board` restituisce anche gli indirizzi per l'iPad).

Cosa installa `pnpm livingboard install` (scope utente, `pnpm livingboard uninstall` lo toglie):

- il server MCP `livingboard` (un ponte stdio che Claude Code avvia nella cartella del progetto: la cartella decide il progetto). Costa poco nei progetti dove non usi la lavagna: due righe di istruzioni e i nomi dei tool (circa 300 token per sessione con il caricamento dei tool su richiesta); le regole complete arrivano solo con `open_board`;
- la skill `/whiteboard` in `~/.claude/skills/whiteboard/`;
- un hook `UserPromptSubmit` in `~/.claude/settings.json`: a ogni messaggio, se sulla lavagna del progetto è cambiato qualcosa dall'ultimo messaggio, Claude lo sa (una riga di contesto, nessuna attesa se il server è spento).

Con la lavagna vuota c'è il pulsante **Carica l'esempio: app meteo**.

Per sviluppare Livingboard: `pnpm dev` (lavagna su http://localhost:5180, in rete con `pnpm dev:lan`). Il ponte usa il server di sviluppo se è già acceso. Lavagne globali, fuori da un progetto: `claude mcp add --transport http livingboard http://localhost:3333/mcp` e `/mcp__livingboard__start`.
Senza Claude puoi verificare il ciclo con un agente finto: `pnpm smoke`.

## Come funziona

```
 browser (Excalidraw)  ──Yjs──►  server Livingboard  ──MCP──►  Claude Code
   tratti, forme, testo            │                         │
   lente AI (overlay)  ◄──Yjs──    ├ segmentazione           ├ wait_for_changes
   viste interattive               ├ attenzione (maturazione)├ get_board_image (vision)
                                   ├ grafo semantico          ├ interpret / set_status
                                   └ render PNG via browser   └ comment / draw / attach_view
```

Tre livelli, dal disegno al significato:

1. **Geometria**: gli elementi Excalidraw grezzi, sincronizzati in tempo reale con Yjs (CRDT).
2. **Candidati**: un pre-passaggio geometrico deterministico raggruppa ciò che probabilmente esprime un'idea sola: forma + testo, tratti vicini, etichette, frecce che collegano due gruppi. Nessuna interpretazione, solo struttura economica da leggere. Gli ID restano stabili mentre disegni.
   - **Scrittura a mano**: i tratti si uniscono con una soglia proporzionale alla grandezza della scrittura (più larga lungo la riga, più stretta tra righe e tra colori diversi).
   - **Frecce disegnate a mano**: un tratto lungo che va da un gruppo a un altro diventa una relazione, con la sua punta. Se invece corre lungo una o due parole (sottolineatura, parentesi) le decora o le unisce.
   - **Quando sbaglia**: selezioni i tratti e tocchi **⧉ È un'idea** (oppure **↺ Automatico** per tornare indietro); l'agente può fare lo stesso guardando l'immagine con `split_node` / `merge_nodes`. Questi gruppi espliciti valgono come i gruppi di Excalidraw: restano sempre uniti e non si fondono con altri.
3. **Grafo semantico**: l'AI assegna a ogni candidato un **tipo libero** (mob, item, bioma…), proprietà strutturate e relazioni. I tipi formano un'**ontologia emergente**: nessuno li definisce prima.

### iPad e tablet (stile GoodNotes)

La modalità tablet si attiva da sola su iPad (o dal pannello, o con `?tablet=1`):

- **Apple Pencil disegna, le dita navigano**: un dito sposta, due dita zoomano, il palmo appoggiato viene ignorato.
- **Tap con due dita = annulla, tap con tre dita = ripeti**; in alto ci sono comunque i pulsanti ↶ ↷.
- **Barra grande** con penna, evidenziatore, gomma, selezione, testo e forme; colori e spessori per ogni strumento, ricordati sul dispositivo.
- Interruttore **dito: naviga / disegna** per chi non ha la penna.
- Si può aggiungere alla schermata Home: si apre a schermo intero come un'app.

Su desktop restano gli strumenti di Excalidraw, con due pulsanti chiari *Annulla* / *Ripeti* in basso.

### Una lavagna pulita

- **Solo disegni**: di base sopra la lavagna non c'è nessuna etichetta. Selezioni qualcosa e compare come Claude l'ha letto (tipo e nome, con la scheda per correggerlo); la **Lente AI** nel pannello mostra etichette, relazioni e stato su tutte le idee, per chi le vuole.
- **I messaggi di Claude si vedono subito**: risposte e domande compaiono aperte accanto a ciò di cui parlano, finché non premi *Ok* o rispondi lì stesso; poi restano come un piccolo ✳ (o un **?** arancione se Claude aspetta una risposta). Quelli sull'intera lavagna o fuori schermo, o con lo zoom lontano, stanno in una casella in alto con *Vai lì*. Il "letto" è per dispositivo.
- **Niente sovrapposizioni**: messaggi ed etichette evitano frecce, disegni e altre idee; le viste si aprono solo su richiesta, oppure restano aperte per tutti se fissate 📌.
- **Riordina**: dal pannello (o proposto da Claude) un riordino ad albero che segue le tue frecce. Si vede in anteprima fantasma e non si muove nulla finché non premi *Applica*; i disegni di Claude legati a un nodo lo seguono.

### Claude disegna, e tiene aggiornato

Claude esprime quello che decide e costruisce **disegnando direttamente sulla lavagna**, nello stile della lavagna (colore d'inchiostro, grandezza della scrittura):

- `draw_svg` è lo strumento principale: Claude scrive SVG (che conosce benissimo) e diventa elementi Excalidraw disegnati a mano e modificabili: rettangoli, ellissi, linee e tracciati (anche archi), riempimenti, testo, frecce, gruppi con trasformazioni. Schermate, oggetti, mappe, timeline, spiegazioni illustrate.
- `draw_table` disegna una tabella: confronti, elenchi con attributi, piani, stati (✓ ⏳), con celle evidenziate.
- `extend` continua la tua struttura ad albero nella direzione delle tue frecce, senza incroci;
- `draw_diagram` (Mermaid), `draw_chart` (barre), `annotate` (cerchia, sottolinea, spunta), `note` (nota a margine), `add_image` (screenshot).

Ogni disegno ha un `drawingId`. Quando il progetto cambia Claude lo **ridisegna sul posto** (`replace`) o lo **cancella** (`erase`) invece di aggiungerne copie, così la lavagna mostra lo stato attuale e non la storia. Se una persona modifica o cancella un disegno di Claude (riscrive una cella, toglie una riga), Claude lo riceve come `drawingEdits` con i testi cambiati e adegua il progetto. Al massimo 20 parole per elemento; il **Documento** (scheda nel pannello) resta per i testi lunghi.

### Immagini

- **Dalle persone**: incolla o trascina un'immagine (su iPad c'è il pulsante 🖼 nel dock) e arriva a tutti i partecipanti. L'agente la vede nel contesto con `get_board_image` e a piena risoluzione con `get_image`.
- **Dall'agente**: `add_image` mette sulla lavagna uno screenshot di ciò che ha costruito, un render o una foto di riferimento, accanto al nodo a cui si riferisce (e lo segue nel riordino). Con `replace` aggiorna la stessa immagine a ogni nuova versione invece di accumularne copie. Come fare lo screenshot (browser, emulatore, gioco...) è affare dell'agente e dei suoi strumenti, non di Livingboard.
- Formati PNG, JPEG, GIF, WebP e SVG, max 4 MB l'una; la stessa immagine è salvata una volta sola.

### Come lavora l'AI

- **Maturazione**: un candidato arriva all'agente solo quando nessuno lo tocca da qualche secondo, così un testo non viene mai letto a metà. Sul canvas non compaiono indicatori di attesa: lo stato sta in una riga del pannello.
- **Riconoscimento**: *implicito* (l'AI interpreta e agisce subito, tu correggi) o *ibrido* (l'AI propone, tu confermi con ✓).
- **Effort**: basso (solo domande `@AI`), medio, alto (propone anche idee "fantasma" da tenere o scartare).
- **Permessi**: sola lettura, chiedi, auto (azioni reversibili senza chiedere, irreversibili sempre con conferma).
- **Non si blocca**: se manca un dettaglio sceglie un valore sensato e lo mostra come ipotesi ⚠ correggibile.
- **Non tocca i tratti umani**: disegna solo con elementi propri, marcati come AI.
- Ogni correzione umana (conferma, scarto, cambio di tipo, risposta, modifica da una vista) torna all'agente come feedback.

### Tool MCP

| Tool | Cosa fa |
|---|---|
| `open_board` | apre (o crea) una lavagna del progetto e la mostra nel browser; URL, indirizzi in rete, altre lavagne |
| `board_overview` | stato, policy, ontologia, candidati, relazioni |
| `wait_for_changes` | long-poll: candidati maturi, feedback, rimozioni, cambi di impostazioni |
| `get_board_image` | PNG di tutta la lavagna o ritagliato su alcuni nodi (renderizzato da un browser aperto) |
| `interpret` | scrive tipi, etichette, props, ipotesi, relazioni, tipi dell'ontologia |
| `set_status` | badge di costruzione su un nodo (building, done con file, error, question) |
| `comment` | commento ancorato a un nodo: risposte `@AI`, domande, note |
| `draw` | forme, testi e frecce di base (max 20 parole); l'AI dice *cosa* e *vicino a cosa*, il server sceglie *dove* |
| `attach_view` | vista interattiva HTML attaccata a un nodo |
| `list_views` | viste salvate nel registro (filtrabili per nodo compatibile) |
| `apply_view` | applica una vista salvata a un nodo |
| `save_view` | salva una vista nel registro |
| `write_doc` | scrive o sostituisce una sezione del Documento (solo testi lunghi) |
| `extend` | aggiunge idee figlie continuando la struttura disegnata |
| `draw_svg` | qualsiasi disegno da SVG: forme, riempimenti, testo, frecce, gruppi |
| `draw_table` | tabella disegnata a mano (fino a 20×8), celle evidenziate |
| `erase` | cancella disegni di Claude superati (per `drawingId`) |
| `ask_permission` | chiede un permesso sulla lavagna: domanda con caselle "☐ Sì ☐ No"; la persona ci fa un segno (spunta a penna, x, ✓) e la risposta arriva in `wait_for_changes.approvals` |
| `delete_text` | cancella un testo, intero o solo una parte; il testo di una persona solo dopo un Sì con `ask_permission` |
| `draw_diagram` | diagramma da Mermaid |
| `draw_chart` | grafico a barre (1-8 valori) |
| `annotate` | cerchio, sottolineatura, evidenziatore, ✓/✗, richiamo |
| `note` | nota a margine |
| `add_image` | immagine da file locale, url o base64, vicino a un nodo; `replace` la aggiorna sul posto |
| `get_image` | l'originale di un'immagine sulla lavagna, a piena risoluzione |
| `propose_layout` | propone un riordino (anteprima, lo applica una persona) |
| `split_node` | divide un candidato con riquadri disegnati sull'immagine (`imageId` di `get_board_image`) |
| `merge_nodes` | unisce più candidati in un'idea |
| `inspect` | dettaglio completo di un candidato |

Prompt MCP: `start` (in Claude Code `/mcp__livingboard__start`).

### Viste interattive (le "estensioni")

Un'estensione è una **vista**: una piccola app HTML che l'AI genera al volo e attacca a un nodo, ad esempio una scheda con slider o una piccola tabella modificabile. Gira in un iframe sandbox (solo script, niente rete) e riceve un oggetto `livingboard`:

```js
livingboard.node          // { id, type, label }
livingboard.props         // proprietà del nodo
livingboard.onProps(fn)   // fn(props) subito e a ogni modifica
livingboard.update(patch) // scrive nelle props; l'agente lo riceve come feedback "view-edit"
livingboard.resize(h)     // altezza della card (anche automatica)
```

La card si trascina dall'intestazione e la posizione è condivisa con tutti.

**Registro delle viste**: con ☆ sull'intestazione salvi una vista nel registro del server (`data/views/*.json`, condiviso da tutte le lavagne). Ogni vista dichiara le **props richieste** (es. `price.amount`): la compatibilità si decide dalla forma dei dati, non dal nome del tipo, perché i tipi li inventa l'AI. La scheda di un nodo mostra le viste compatibili da applicare con un tocco; l'agente fa lo stesso con `list_views` / `apply_view` e salva le sue con `save_view`.

## Struttura

```
packages/shared   schema del documento condiviso (tipi, chiavi Yjs, impostazioni)
packages/server   sync Yjs, segmentazione, attenzione, MCP, persistenza in data/
packages/web      Excalidraw + overlay AI + pannello + viste
demo/minecraft-pack  esempio d'uso: un add-on Minecraft costruito da Claude a partire da una lavagna (.mcp.json + CLAUDE.md del progetto)
```

Utili:

- `pnpm --filter @livingboard/server exec tsx scripts/mcp.ts call board_overview`: client MCP da terminale (`@file.json` per argomenti lunghi, `--out` per salvare le immagini).
- Lavagne di un progetto: `?p=<id progetto>&board=nome` (l'id è nome della cartella + hash del percorso, registrato in `data/projects.json`); file in `<progetto>/.livingboard/boards/`. Lavagne globali: `?board=nome`, file in `data/<nome>.ydoc`.
- `pnpm --filter @livingboard/server exec tsx scripts/bridge-smoke.ts <cartella> [lavagna]`: parla col ponte stdio come Claude Code.
- Il server avviato dal ponte scrive il log in `data/server.log`.
- `pnpm build && pnpm start`: un solo processo su http://localhost:3333 (lavagna + MCP).
- `LIVINGBOARD_PORT`, `LIVINGBOARD_HOST`, `LIVINGBOARD_DATA` per porta, interfaccia e cartella dati.

## Sicurezza

Il server ascolta solo su `127.0.0.1` e rifiuta richieste dal browser con origini estranee. Non c'è autenticazione: se lo esponi in rete (`LIVINGBOARD_HOST=0.0.0.0`) chiunque possa raggiungerlo può modificare la lavagna e parlare con l'agente. Solo un agente sullo stesso computer può dire a quale cartella di progetto appartiene (`x-livingboard-project`), perché il server scrive lì le lavagne; il browser apre la lavagna di un progetto solo se quel progetto è già stato registrato da un agente locale. `add_image` legge file per percorso solo se l'agente è sullo stesso computer del server (chi arriva dalla rete può passare solo url o base64), e accetta solo file che sono davvero immagini. Il contenuto della lavagna arriva all'agente come dato, ma i permessi (sola lettura / chiedi) restano la difesa principale quando collabori con persone di cui non ti fidi.

## Limiti noti

- Le immagini viaggiano dentro il documento della lavagna: tante foto grandi la rendono pesante da caricare per tutti.
- Le frecce disegnate dall'AI non sono legate alle forme: se sposti un box non lo seguono.
- Il riconoscimento degli schizzi dipende dalla vision dell'agente (`get_board_image`).
- Un agente per lavagna alla volta (il cursore del feedback è unico).
- Gesti del tablet verificati con eventi simulati; la sensibilità del rifiuto del palmo va tarata su un iPad vero.

## Roadmap

- Agente sempre attivo lato server (Agent SDK) in alternativa al ciclo MCP.
- Confronto misurato tra riconoscimento ibrido e implicito.
- Autenticazione e lavagne remote.

## Licenza

MIT
