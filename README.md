# ✳ Livingboard

Open-source collaborative whiteboard that works as the **living prompt** of a project built with AI.

With a text prompt you give an instruction, get a result, and after an hour of chat the big picture is lost in the scroll. In Livingboard the prompt is the board: you draw it, Claude reads it, builds, and puts back on the board what it did (screens, tables, diagrams, screenshots). People and Claude both edit it over time, and **board and project always match**: change a cell in Claude's table and Claude changes the project; Claude changes the project and updates the drawing.

The link to the AI goes through **MCP**, so it works with Claude Code or any MCP client.

> Example: you draw an app with boxes, arrows and a sketch. Claude recognises features and data, answers `@AI` questions with a message on the board, draws the first screen and the alerts table next to it, builds the project in its folder and keeps everything up to date.

**When it pays off (and when it doesn't).** The board wins when position is the content (screens, flows, maps, architectures), when the project lasts weeks and has to be understood at a glance, when several people work on it, when you compare or prioritise (tables, matrices), with pen and tablet. For bugs, refactoring, precise rules and numbers, text is still faster: Livingboard does not replace it, it gives it a map.

Livingboard knows nothing about any domain: no plugins for games, apps or documents. The agent brings the domain (and the folder it works in); the board only offers generic tools to read, draw and show images.

## Quick start

Requires Node.js 22+ and [Claude Code](https://claude.com/claude-code). Once:

```bash
npm install -g livingboard
livingboard install
```

Then in **any project**, in a new Claude Code session:

```
/whiteboard          the project's "main" board
/whiteboard ui       another board of the same project
```

Claude opens the board in the browser and works on it. Nothing to start by hand: the server starts by itself on the first call and stays up for all projects. A project's boards are saved **in the project**, in `.livingboard/boards/<name>.ydoc`, so they travel and are versioned with the code. For a tablet: `livingboard install --lan` (the server becomes reachable on the network; `open_board` also returns the addresses for the iPad).

What `livingboard install` sets up (user scope; `livingboard uninstall` removes it):

- the `livingboard` MCP server (a stdio bridge that Claude Code starts in the project folder: the folder decides the project). It costs little in projects where you don't use the board: two lines of instructions and the tool names (about 300 tokens per session with on-demand tool loading); the full rules arrive only with `open_board`;
- the `/whiteboard` skill in `~/.claude/skills/whiteboard/`;
- a `UserPromptSubmit` hook in `~/.claude/settings.json`: on every message, if something changed on the project's board since the last message, Claude knows (one line of context, no wait if the server is off).

Global boards, the project registry and the server log live in `~/.livingboard/` (`LIVINGBOARD_DATA` to move them). `livingboard start [--lan]` runs the server in the foreground, to use boards without Claude Code (http://localhost:3333). After `npm update -g livingboard`, run `livingboard install` again only if the package moved (a different Node.js install).

On an empty board there is a **Load the example: weather app** button.

### From source

```bash
pnpm install
pnpm livingboard install
```

Same commands as above, prefixed with `pnpm` and run from the repo; data then lives in the repo's `data/`. To develop Livingboard: `pnpm dev` (board on http://localhost:5180, on the network with `pnpm dev:lan`). The bridge uses the dev server if it is already running. Global boards, outside a project: `claude mcp add --transport http livingboard http://localhost:3333/mcp` and `/mcp__livingboard__start`.
Without Claude you can check the loop with a fake agent: `pnpm smoke`. `pnpm pack:npm` builds the npm package (`packages/livingboard`).

## How it works

```
 browser (Excalidraw)  ──Yjs──►  Livingboard server  ──MCP──►  Claude Code
   strokes, shapes, text           │                         │
   AI lens (overlay)   ◄──Yjs──    ├ segmentation            ├ wait_for_changes
   interactive views               ├ attention (maturation)  ├ get_board_image (vision)
                                   ├ semantic graph          ├ interpret / set_status
                                   └ PNG render via browser  └ comment / draw / attach_view
```

Three layers, from drawing to meaning:

1. **Geometry**: raw Excalidraw elements, synced in real time with Yjs (CRDT).
2. **Candidates**: a deterministic geometric pre-pass groups what probably expresses a single idea: shape + text, nearby strokes, labels, arrows linking two groups. No interpretation, just cheap structure to read. IDs stay stable while you draw.
   - **Handwriting**: strokes join with a threshold proportional to the writing size (wider along the line, tighter between lines and between colours).
   - **Hand-drawn arrows**: a long stroke going from one group to another becomes a relation, with its arrowhead. If it runs along one or two words instead (underline, bracket), it decorates or joins them.
   - **When it gets it wrong**: select the strokes and tap **⧉ One idea** (or **↺ Automatic** to go back); the agent can do the same by looking at the image with `split_node` / `merge_nodes`. These explicit groups work like Excalidraw groups: they always stay together and never merge with others.
3. **Semantic graph**: the AI gives each candidate a **free type** (mob, item, biome…), structured properties and relations. The types form an **emergent ontology**: nobody defines them upfront.

### iPad and tablets (GoodNotes style)

Tablet mode turns on by itself on iPad (or from the panel, or with `?tablet=1`):

- **Apple Pencil draws, fingers navigate**: one finger pans, two fingers zoom, a resting palm is ignored.
- **Two-finger tap = undo, three-finger tap = redo**; the ↶ ↷ buttons are at the top anyway.
- **Big toolbar** with pen, highlighter, eraser, selection, text and shapes; colours and widths per tool, remembered on the device.
- **Finger: pan / draw** switch for people without a pen.
- Can be added to the Home Screen: it opens full screen like an app.

On desktop the Excalidraw tools stay, with two clear *Undo* / *Redo* buttons at the bottom.

### A clean board

- **Just drawings**: by default there are no labels over the board. Select something and you see how Claude read it (type and name, with the card to correct it); the **AI lens** in the panel shows labels, relations and status on every idea, for those who want them.
- **Claude's messages show up right away**: answers and questions appear open next to what they are about, until you press *Ok* or reply right there; then they stay as a small ✳ (or an orange **?** if Claude is waiting for an answer). Those about the whole board, off screen, or when zoomed far out sit in an inbox at the top with *Go there*. "Read" is per device.
- **No overlaps**: messages and labels avoid arrows, drawings and other ideas; views open only on request, or stay open for everyone when pinned 📌.
- **Tidy the board**: from the panel (or proposed by Claude) a tree layout that follows your arrows. You see a ghost preview and nothing moves until you press *Apply*; Claude's drawings tied to a node follow it.

### Claude draws, and keeps it up to date

Claude expresses what it decides and builds **by drawing directly on the board**, in the board's style (ink colour, writing size):

- `draw_svg` is the main tool: Claude writes SVG (which it knows very well) and it becomes hand-drawn, editable Excalidraw elements: rectangles, ellipses, lines and paths (arcs too), fills, text, arrows, groups with transforms. Screens, objects, maps, timelines, illustrated explanations.
- `draw_table` draws a table: comparisons, lists with attributes, plans, statuses (✓ ⏳), with highlighted cells.
- `extend` continues your tree structure in the direction of your arrows, without crossings;
- `draw_diagram` (Mermaid), `draw_chart` (bars), `annotate` (circle, underline, tick), `note` (side note), `add_image` (screenshot).

Every drawing has a `drawingId`. When the project changes Claude **redraws it in place** (`replace`) or **erases it** (`erase`) instead of adding copies, so the board shows the current state, not the history. If a person edits or deletes one of Claude's drawings (rewrites a cell, removes a row), Claude receives it as `drawingEdits` with the changed texts and updates the project. At most 20 words per element; the **Document** (a tab in the panel) is for long texts.

Claude writes on the board in the language people use there.

### Images

- **From people**: paste or drag an image (on iPad there is the 🖼 button in the dock) and it reaches every participant. The agent sees it in context with `get_board_image` and at full resolution with `get_image`.
- **From the agent**: `add_image` puts on the board a screenshot of what it built, a render or a reference photo, next to the node it refers to (and follows it when rearranged). With `replace` it updates the same image at every new version instead of piling up copies. How to take the screenshot (browser, emulator, game...) is up to the agent and its tools, not Livingboard.
- PNG, JPEG, GIF, WebP and SVG, max 4 MB each; the same image is stored only once.

### How the AI works

- **Maturation**: a candidate reaches the agent only when nobody has touched it for a few seconds, so a text is never read half-written. No waiting indicators on the canvas: the status is one line in the panel.
- **Recognition**: *implicit* (the AI interprets and acts right away, you correct) or *hybrid* (the AI proposes, you confirm with ✓).
- **Effort**: low (only `@AI` questions), medium, high (also proposes "ghost" ideas to keep or discard).
- **Permissions**: read-only, ask, auto (reversible actions without asking, irreversible ones always confirmed).
- **Never stuck**: if a detail is missing it picks a sensible value and shows it as a ⚠ assumption you can correct.
- **Never touches human strokes**: it draws only with its own elements, marked as AI.
- Every human correction (confirm, discard, change of type, answer, edit from a view) goes back to the agent as feedback.

### MCP tools

| Tool | What it does |
|---|---|
| `open_board` | opens (or creates) a project board and shows it in the browser; URL, network addresses, other boards |
| `board_overview` | status, policy, ontology, candidates, relations |
| `wait_for_changes` | long-poll: mature candidates, feedback, removals, settings changes |
| `get_board_image` | PNG of the whole board or cropped to some nodes (rendered by an open browser) |
| `interpret` | writes types, labels, props, assumptions, relations, ontology types |
| `set_status` | build badge on a node (building, done with files, error, question) |
| `comment` | comment anchored to a node: `@AI` answers, questions, notes |
| `draw` | basic shapes, texts and arrows (max 20 words); the AI says *what* and *near what*, the server picks *where* |
| `attach_view` | interactive HTML view attached to a node |
| `list_views` | views saved in the registry (filterable by compatible node) |
| `apply_view` | applies a saved view to a node |
| `save_view` | saves a view in the registry |
| `write_doc` | writes or replaces a section of the Document (long texts only) |
| `extend` | adds child ideas continuing the drawn structure |
| `draw_svg` | any drawing from SVG: shapes, fills, text, arrows, groups |
| `draw_table` | hand-drawn table (up to 20×8), highlighted cells |
| `erase` | erases outdated Claude drawings (by `drawingId`) |
| `ask_permission` | asks for permission on the board: a question with "☐ Yes ☐ No" boxes; the person marks one (pen tick, x, ✓) and the answer arrives in `wait_for_changes.approvals` |
| `delete_text` | deletes a text, whole or in part; a person's text only after a Yes with `ask_permission` |
| `draw_diagram` | diagram from Mermaid |
| `draw_chart` | bar chart (1-8 values) |
| `annotate` | circle, underline, highlighter, ✓/✗, callout |
| `note` | side note |
| `add_image` | image from a local file, url or base64, near a node; `replace` updates it in place |
| `get_image` | the original of an image on the board, at full resolution |
| `propose_layout` | proposes a layout (preview, a person applies it) |
| `split_node` | splits a candidate with boxes drawn on the image (`imageId` from `get_board_image`) |
| `merge_nodes` | merges several candidates into one idea |
| `inspect` | full detail of a candidate |

MCP prompt: `start` (in Claude Code `/mcp__livingboard__start`).

### Interactive views (the "extensions")

An extension is a **view**: a small HTML app the AI generates on the fly and attaches to a node, for example a card with sliders or a small editable table. It runs in a sandboxed iframe (scripts only, no network) and gets a `livingboard` object:

```js
livingboard.node          // { id, type, label }
livingboard.props         // the node's properties
livingboard.onProps(fn)   // fn(props) right away and on every change
livingboard.update(patch) // writes into props; the agent receives it as "view-edit" feedback
livingboard.resize(h)     // card height (automatic too)
```

The card is dragged by its header and its position is shared with everyone.

**View registry**: with ☆ on the header you save a view in the server's registry (`data/views/*.json`, shared by all boards). Every view declares its **required props** (e.g. `price.amount`): compatibility is decided by the shape of the data, not by the type name, because the AI invents the types. A node's card shows the compatible views to apply with one tap; the agent does the same with `list_views` / `apply_view` and saves its own with `save_view`.

## Layout

```
packages/shared   shared document schema (types, Yjs keys, settings)
packages/server   Yjs sync, segmentation, attention, MCP, persistence in data/
packages/web      Excalidraw + AI overlay + panel + views
packages/livingboard  the npm package: server and CLI bundled with esbuild + the built page
demo/minecraft-pack  usage example: a Minecraft add-on built by Claude from a board (.mcp.json + the project's CLAUDE.md)
```

Handy:

- `pnpm --filter @livingboard/server exec tsx scripts/mcp.ts call board_overview`: MCP client from the terminal (`@file.json` for long arguments, `--out` to save images).
- Project boards: `?p=<project id>&board=name` (the id is the folder name + a hash of the path, registered in `data/projects.json`); files in `<project>/.livingboard/boards/`. Global boards: `?board=name`, file in `data/<name>.ydoc`.
- `pnpm --filter @livingboard/server exec tsx scripts/bridge-smoke.ts <folder> [board]`: talks to the stdio bridge like Claude Code (it draws a test table: use a throwaway folder).
- The server started by the bridge logs to `data/server.log`.
- `pnpm build && pnpm start`: a single process on http://localhost:3333 (board + MCP).
- `LIVINGBOARD_PORT`, `LIVINGBOARD_HOST`, `LIVINGBOARD_DATA` for port, interface and data folder.

## Security

The server listens only on `127.0.0.1` and refuses browser requests from foreign origins. There is no authentication: if you expose it on the network (`LIVINGBOARD_HOST=0.0.0.0`) anyone who can reach it can edit the board and talk to the agent. Only an agent on the same computer can say which project folder it belongs to (`x-livingboard-project`), because the server writes the boards there; the browser opens a project board only if that project was already registered by a local agent. `add_image` reads files by path only if the agent is on the same computer as the server (callers from the network can only pass a url or base64), and accepts only files that really are images. Board content reaches the agent as data, but permissions (read-only / ask) remain the main defence when you collaborate with people you don't trust.

## Known limits

- Images travel inside the board document: many large photos make it heavy to load for everyone.
- Arrows drawn by the AI are not bound to shapes: if you move a box they don't follow.
- Sketch recognition depends on the agent's vision (`get_board_image`).
- One agent per board at a time (the feedback cursor is single).
- Tablet gestures were checked with simulated events; palm rejection sensitivity needs tuning on a real iPad.

## Roadmap

- Always-on server-side agent (Agent SDK) as an alternative to the MCP loop.
- Measured comparison between hybrid and implicit recognition.
- Authentication and remote boards.

## License

MIT
