# Minecraft Bedrock add-on built from a Livingboard board

This folder is the workshop: whoever draws on the board describes the mod, you build it here.
The `livingboard` MCP server (see `.mcp.json`) connects you to the board.

## Start

Run `/mcp__livingboard__start` with goal "build the Bedrock add-on in this folder", then stay in the loop
`wait_for_changes → interpret → build → set_status → wait_for_changes`. Questions for people go
on the board with `comment`, not in the chat.

## From the graph to files

| Type on the board | Files |
|---|---|
| mob | `*_BP/entities/<name>.json`, `*_BP/loot_tables/entities/<name>.json`, `*_RP/entity/<name>.entity.json` |
| item / weapon / material | `*_BP/items/<name>.json` + entry in `*_RP/textures/item_texture.json` |
| recipe (also inside an item's props) | `*_BP/recipes/<name>.json` |
| biome linked with "spawns in" | `*_BP/spawn_rules/<mob>.json` (biome tag filter) |
| "drops" relation | pool in the source mob's loot table |

- Namespace `livingboard:`; use the node's `props.identifier` when present.
- Translated names in `*_RP/texts/en_US.lang` and `it_IT.lang`.
- Missing art: use vanilla models and textures as placeholders and say so in the `assumptions`.
- Before working on a node `set_status(building)`, afterwards `set_status(done, files)` with paths relative
  to the repo root (e.g. `demo/minecraft-pack/frost_golem_BP/items/frost_sword.json`).
- On the board, draw rather than write: `extend` to add mobs/items to the diagram, `draw_svg` to show an object, `draw_table` for stats, drops and recipes, `annotate` to flag problems. When they change, update the drawings with `replace`.
- `view-edit` feedback: the user changed props from an interactive view → bring the files in line.
- `retype` or `reject` feedback: a person corrected your reading → adapt or clean up.

## Trying it in Minecraft

Copy (or symlink) `frost_golem_BP` into `development_behavior_packs` and `frost_golem_RP`
into `development_resource_packs` of the `com.mojang` folder, enable them in a test world, then `/reload`.
