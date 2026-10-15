# Add-on Minecraft Bedrock costruito da una lavagna Sinapsi

Questa cartella è il cantiere: chi disegna sulla lavagna descrive la mod, tu la costruisci qui.
Il server MCP `sinapsi` (vedi `.mcp.json`) ti collega alla lavagna.

## Avvio

Esegui `/mcp__sinapsi__start` con goal "costruisci l'add-on Bedrock in questa cartella", poi resta nel ciclo
`wait_for_changes → interpret → costruisci → set_status → wait_for_changes`. Le domande per gli umani vanno
sulla lavagna con `comment`, non in chat.

## Dal grafo ai file

| Tipo sulla lavagna | File |
|---|---|
| mob | `*_BP/entities/<nome>.json`, `*_BP/loot_tables/entities/<nome>.json`, `*_RP/entity/<nome>.entity.json` |
| item / arma / materiale | `*_BP/items/<nome>.json` + voce in `*_RP/textures/item_texture.json` |
| ricetta (anche dentro le props di un item) | `*_BP/recipes/<nome>.json` |
| bioma collegato con "spawna in" | `*_BP/spawn_rules/<mob>.json` (filtro sui biome tag) |
| relazione "drops" | pool nella loot table del mob di partenza |

- Namespace `sinapsi:`; usa `props.identifier` del nodo quando c'è.
- Nomi tradotti in `*_RP/texts/en_US.lang` e `it_IT.lang`.
- Grafica mancante: usa modelli e texture vanilla come segnaposto e scrivilo nelle `assumptions`.
- Prima di lavorare su un nodo `set_status(building)`, dopo `set_status(done, files)` con percorsi relativi
  alla radice del repo (es. `demo/minecraft-pack/frost_golem_BP/items/frost_sword.json`).
- Sulla lavagna disegna, non scrivere: `extend` per aggiungere mob/item allo schema, `draw_sketch` per far vedere un oggetto, `annotate` per segnalare problemi. Schede e riepiloghi (statistiche, drop, ricette) vanno nel Documento con `write_doc`.
- Feedback `view-edit`: l'utente ha modificato le props da una vista interattiva → riallinea i file.
- Feedback `retype` o `reject`: l'umano ha corretto la tua lettura → adegua o ripulisci.

## Provare in Minecraft

Copia (o collega con un link simbolico) `frost_golem_BP` in `development_behavior_packs` e `frost_golem_RP`
in `development_resource_packs` della cartella `com.mojang`, attivali in un mondo di prova, poi `/reload`.
