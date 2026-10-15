# ✳ Sinapsi

Lavagna collaborativa open source che l'AI **capisce mentre disegni**.
Disegni un'idea, l'AI la legge come significato (non come pixel), la trasforma in azioni e ti mostra sulla lavagna cosa ha capito e cosa sta facendo. Il collegamento con l'AI passa da **MCP**, quindi funziona con Claude Code o con qualsiasi client MCP.

> Esempio: disegni un'app con riquadri, frecce e uno schizzo; mentre disegni, Claude riconosce funzioni e dati, risponde alle domande `@AI`, costruisce il progetto nella sua cartella e mette accanto a ogni idea lo stato di costruzione e uno screenshot del risultato.

Sinapsi non sa niente di nessun dominio: niente plugin per giochi, app o documenti. Il dominio lo porta l'agente (e la cartella in cui lavora); la lavagna offre solo strumenti generici per leggere, disegnare e mostrare immagini.

## Avvio rapido

```bash
pnpm install
pnpm dev
```

Apri http://localhost:5180 (da altri dispositivi della rete: `pnpm dev:lan`, poi `http://<ip-del-pc>:5180`) e collega Claude Code alla lavagna:

```bash
claude mcp add --transport http sinapsi http://localhost:3333/mcp
```

Poi dentro Claude Code esegui `/mcp__sinapsi__start`. Con la lavagna vuota c'è il pulsante **Carica l'esempio: app meteo**.
Senza Claude puoi verificare il ciclo con un agente finto: `pnpm smoke`.

## Come funziona

```
 browser (Excalidraw)  ──Yjs──►  server Sinapsi  ──MCP──►  Claude Code
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

### Una lavagna in ordine

- **Un posto per ogni cosa**: sulla lavagna solo disegni; nome e tipo di ogni idea in un'etichetta di una riga; dettagli, ipotesi e discussione nella scheda del nodo; riepiloghi ed elenchi nel **Documento** (scheda nel pannello, esportabile in Markdown).
- **Niente sovrapposizioni**: le etichette evitano frecce, disegni e altre idee (se lo spazio è poco mostrano solo il nome, poi solo l'icona), i commenti aspettano in un badge 💬, le viste si aprono solo su richiesta (▣ sull'etichetta) nello spazio libero, oppure restano aperte per tutti se fissate 📌.
- **Riquadri solo quando servono**: il contorno attorno a un'idea compare passandoci sopra, con la sua scheda aperta o mentre Claude ci lavora; nel pannello c'è l'interruttore per vederli sempre.
- **Zoom semantico**: da lontano restano solo i titoli delle idee, da vicino compaiono etichette, relazioni e viste.
- **Riordina**: dal pannello (o proposto da Claude) un riordino ad albero che segue le tue frecce, nella direzione in cui le hai disegnate. Si vede in anteprima fantasma e non si muove nulla finché non premi *Applica*; le frecce si stirano e i disegni di Claude legati a un nodo lo seguono.

### Claude disegna

Claude è spinto a disegnare invece di scrivere: sulla lavagna al massimo 12 parole per elemento (il server rifiuta il resto e lo rimanda al Documento), e ha strumenti fatti per disegnare nello **stile della lavagna** (colore d'inchiostro, grandezza della scrittura, box o parole, frecce a mano o no):

- `extend` continua la tua struttura nella direzione delle tue frecce, scegliendo tra ventaglio e "pettine" (per le liste lunghe) la disposizione in cui nessun figlio e nessuna freccia copre qualcosa;
- `draw_sketch` disegna oggetti a mano libera partendo da un SVG;
- `draw_diagram` trasforma un diagramma Mermaid in forme disegnate a mano (lo converte il browser);
- `draw_chart` risponde con un piccolo grafico a barre;
- `annotate` cerchia, sottolinea, evidenzia, spunta o richiama ciò che hai disegnato, senza toccarlo;
- `note` scrive una nota breve a margine, legata al nodo da una linea puntinata.

### Immagini

- **Dalle persone**: incolla o trascina un'immagine (su iPad c'è il pulsante 🖼 nel dock) e arriva a tutti i partecipanti. L'agente la vede nel contesto con `get_board_image` e a piena risoluzione con `get_image`.
- **Dall'agente**: `add_image` mette sulla lavagna uno screenshot di ciò che ha costruito, un render o una foto di riferimento, accanto al nodo a cui si riferisce (e lo segue nel riordino). Con `replace` aggiorna la stessa immagine a ogni nuova versione invece di accumularne copie. Come fare lo screenshot (browser, emulatore, gioco...) è affare dell'agente e dei suoi strumenti, non di Sinapsi.
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
| `board_overview` | stato, policy, ontologia, candidati, relazioni |
| `wait_for_changes` | long-poll: candidati maturi, feedback, rimozioni, cambi di impostazioni |
| `get_board_image` | PNG di tutta la lavagna o ritagliato su alcuni nodi (renderizzato da un browser aperto) |
| `interpret` | scrive tipi, etichette, props, ipotesi, relazioni, tipi dell'ontologia |
| `set_status` | badge di costruzione su un nodo (building, done con file, error, question) |
| `comment` | commento ancorato a un nodo: risposte `@AI`, domande, note |
| `draw` | forme, testi e frecce di base (max 12 parole); l'AI dice *cosa* e *vicino a cosa*, il server sceglie *dove* |
| `attach_view` | vista interattiva HTML attaccata a un nodo |
| `list_views` | viste salvate nel registro (filtrabili per nodo compatibile) |
| `apply_view` | applica una vista salvata a un nodo |
| `save_view` | salva una vista nel registro |
| `write_doc` | scrive o sostituisce una sezione del Documento |
| `extend` | aggiunge idee figlie continuando la struttura disegnata |
| `draw_sketch` | schizzo a mano libera da SVG |
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

Prompt MCP: `start` (in Claude Code `/mcp__sinapsi__start`).

### Viste interattive (le "estensioni")

Un'estensione è una **vista**: una piccola app HTML che l'AI genera al volo e attacca a un nodo, ad esempio una scheda con slider o una piccola tabella modificabile. Gira in un iframe sandbox (solo script, niente rete) e riceve un oggetto `sinapsi`:

```js
sinapsi.node          // { id, type, label }
sinapsi.props         // proprietà del nodo
sinapsi.onProps(fn)   // fn(props) subito e a ogni modifica
sinapsi.update(patch) // scrive nelle props; l'agente lo riceve come feedback "view-edit"
sinapsi.resize(h)     // altezza della card (anche automatica)
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

- `pnpm --filter @sinapsi/server exec tsx scripts/mcp.ts call board_overview`: client MCP da terminale (`@file.json` per argomenti lunghi, `--out` per salvare le immagini).
- `?board=nome` nell'URL per lavagne separate; i dati stanno in `data/<nome>.ydoc`.
- `pnpm build && pnpm start`: un solo processo su http://localhost:3333 (lavagna + MCP).
- `SINAPSI_PORT`, `SINAPSI_HOST`, `SINAPSI_DATA` per porta, interfaccia e cartella dati.

## Sicurezza

Il server ascolta solo su `127.0.0.1` e rifiuta richieste dal browser con origini estranee. Non c'è autenticazione: se lo esponi in rete (`SINAPSI_HOST=0.0.0.0`) chiunque possa raggiungerlo può modificare la lavagna e parlare con l'agente. `add_image` legge file per percorso solo se l'agente è sullo stesso computer del server (chi arriva dalla rete può passare solo url o base64), e accetta solo file che sono davvero immagini. Il contenuto della lavagna arriva all'agente come dato, ma i permessi (sola lettura / chiedi) restano la difesa principale quando collabori con persone di cui non ti fidi.

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
