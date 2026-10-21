# Livingboard: developer notes

Collaborative whiteboard (Excalidraw + Yjs) read by AI via MCP. User overview in the README.

## Commands

- `pnpm dev`: server (port 3333, tsx watch) + web (Vite, 5180) in parallel
- `pnpm dev:lan`: same, but reachable from the network (server with `--lan`, Vite with `--host 0.0.0.0`)
- `pnpm typecheck`: all packages
- `pnpm smoke`: fake agent that exercises the MCP loop without an LLM
- `pnpm pack:npm`: builds the page, then the npm package in `packages/livingboard` (`build.mjs`: esbuild bundles `cli.ts` and `index.ts` with every dependency into `dist/`, copies the page to `web/`, the hook, README and LICENSE) and packs `livingboard-<version>.tgz`. Publish: bump `version` in `packages/livingboard/package.json`, then `npm publish` from that folder (`prepack` rebuilds `dist/`, but run `pnpm build` first for the page).
- `pnpm livingboard install [--lan]` / `uninstall`: stdio MCP server (user scope), `/whiteboard` skill, `UserPromptSubmit` hook
- `pnpm --filter @livingboard/server exec tsx scripts/bridge-smoke.ts <folder> [board]`: tries the stdio bridge the way Claude Code would. It draws a test table on that board: point it at a throwaway folder, never a real project.
- `pnpm --filter @livingboard/server exec tsx scripts/mcp.ts call <tool> [json|@file]`: MCP client from the terminal (project = the current folder, or `LIVINGBOARD_PROJECT`)
- `pnpm --filter @livingboard/server exec tsx scripts/segment-debug.ts <project>/.livingboard/boards/<board>.ydoc [--svg out.svg]`: offline segmentation of a saved board (SVG coloured by group)

## Architecture in short

- `packages/shared/src/index.ts`: the single contract. Every `DOC.*` key is a Y.Map/Y.Array of JSON objects replaced whole.
- `packages/server/src/segment.ts`: pure geometric pre-pass (elements → candidates + links). No semantics.
- `packages/server/src/board.ts`: per-board state, maturation (attention), queue for `wait_for_changes`, AI cursor, persistence.
- `packages/server/src/mcp.ts`: MCP tools; stateless server, one instance per request.
- `packages/web/src/collab.ts`: Excalidraw ↔ Y.Map binding (highest `version` wins) + awareness.
- `packages/web/src/Overlay.tsx`: AI lens drawn over the canvas in screen coordinates.
- `packages/web/src/gestures.ts` + `Dock.tsx`: tablet mode (fingers = navigation, pen = drawing, 2/3-finger tap = undo/redo).
- `packages/server/src/registry.ts`: view registry in `data/views/*.json`, exposed on `/api/views` and via MCP.
- `packages/server/src/draw.ts`: all of the agent's drawings (shapes, notes, annotations, SVG scenes, tables, charts, images, `extend`). It always decides the *where*; at most 20 words per element.
- `packages/server/src/svgpath.ts`: SVG → scene (rect, ellipse, line/path with arcs, text, arrows from markers, `<g>` transforms, inherited paint).
- `packages/web/src/Messages.tsx`: Claude's messages on the board (bubbles open until read, ✳ mark, inbox at the top); "read" stored per device in localStorage.
- `packages/shared/src/layout.ts`: tree layout shared by the server (`propose_layout`) and the browser (*Tidy the board* in the main menu).
- `packages/web/src/Panel.tsx`: Claude's panel is an Excalidraw `Sidebar` (name `livingboard`, tabs Activity / Document / Settings), opened by `PanelTrigger` next to Library (`renderTopRightUI`). Closed at start; docked or floating is remembered per device (`livingboard:docked`). Styles in `panel.css` use Excalidraw's CSS tokens, so it follows the dark theme. Board actions (tidy, example) live in Excalidraw's `MainMenu` in `App.tsx`.
- `packages/web/src/Document.tsx`: Document tab (`write_doc` sections + map generated from the graph).
- `packages/server/src/cli.ts`: `livingboard mcp` is the stdio bridge Claude Code starts in the project. Tool list from the same `createMcpServer` in memory (no server needed to list them); on the first call it starts the server detached (`data/server.log`) and forwards to `/mcp` with the `x-livingboard-project` header (the folder). It announces only short instructions (`BRIEF_INSTRUCTIONS`: every session of every project pays for them); the full rules (`INSTRUCTIONS`) come back in `open_board.rules`. `install`/`uninstall` live here too.
- `packages/server/src/projects.ts`: projects (id = folder name + path hash, in `data/projects.json`) and board keys `<id>:<name>` (file in `<project>/.livingboard/boards/`). Every board belongs to a project: no global boards (`boardKey` throws without one), and `/` without `?p=` is the home page (`Home.tsx`, `/api/projects`). `Board.name` is the key (websocket, render), `Board.label` the name for people and the agent.
- `packages/server/bin/livingboard-hook.mjs`: `UserPromptSubmit` hook, plain JavaScript without dependencies (runs on every prompt in every project); asks `/api/digest`, which counts changes with `Board.pending()` without consuming them and never repeats the same change in the same session.
- `packages/server/src/image.ts`: image loading for `add_image` (format from the bytes, size from the header, id = sha1 like Excalidraw).

## Known pitfalls

- Server environment variables: `LIVINGBOARD_PORT` / `LIVINGBOARD_HOST` (not `PORT`: launchers set it for Vite). `LIVINGBOARD_PROJECT` forces the project folder for bridge and hook; `LIVINGBOARD_WEB_URL` the page address.
- `pnpm dev` passes `--dev` to the server: `open_board` points to Vite (5180) instead of the build (3333). If the bridge already started a server, the dev one says "already running" and exits: close that process first. Vite talks to port 3333 (`web/src/server.ts`).
- Port: the server probes it before listening (Windows lets an IPv4 and an IPv6 server share a port silently). Another Livingboard → exit; another program → next port, up to +20, unless `LIVINGBOARD_PORT` pins it. The port goes in `<data>/server.json`: the bridge reads it (`base()` in `cli.ts`), the hook gets the data folder as its argument.
- LAN (`lan.ts`): requests from this machine never need the token; others need the `livingboard_token` cookie (set by `/?t=<token>` from the QR code, then a redirect without it) or `Authorization: Bearer`, for pages, API and websockets. `/mcp` is loopback only. Token in `<data>/lan.json`; `POST /api/lan/reset` (loopback only) replaces it.
- Readable copy (`mirror.ts`): every save also writes `<board>.md` next to the `.ydoc` (only when it changed; stable order, no timestamps). Generated, never read back.
- The stdio bridge must not write to stdout (it is the MCP channel): logs go to stderr only.
- Hand-written Yjs sync in `yserver.ts`: `@y/websocket-server` requires yjs 14.
- Excalidraw colours remote cursors from a hash of the `id`: "claude-52" gives the AI orange.
- `excalidrawAPI` is called inside Excalidraw's constructor: store it with `queueMicrotask`.
- Free text near the middle of an arrow = the arrow's label (otherwise a box swallows it and the arrow loses an end).
- Hand strokes: "wires" (long straight strokes, or long loose ones that are not closed) stay out of clustering and later become links, decorations or merges (`runsAlong`). The thresholds are at the top of `segment.ts`: retune them with `segment-debug.ts` on a real drawing before changing them.
- Explicit groups (`DOC.groups`, human or AI) = must-link + cannot-link in the union-find; an element belongs to one group only.
- A candidate ID is reused only if the new version contains at least half of the elements: after a split every part is new and the old interpretation is dropped.
- MCP: `WebStandardStreamableHTTPServerTransport` with manual piping; the SDK's Node wrapper corrupted chunked encoding.
- Once mounted, Excalidraw resets the scene to `initialData`: the board loads by passing the elements of the first Yjs sync as `initialData`, not with `updateScene`.
- A malformed fractional index stops every client from loading: `collab.ts` and `draw.ts` drop invalid indices.
- Clipped text: a text measured before Excalifont is loaded keeps the fallback font's width and the canvas cuts it off (Safari never loads fonts by itself for the canvas). `collab.ts` (`fitText`) loads the glyphs of texts that arrive from the server and re-measures them locally, without changing `version`.
- No animated per-element indicators on the canvas (the owner's choice): AI status goes in the panel.
- In dev, `window.__excalidraw` and `window.__collab` are exposed for debugging.
- No domain logic in the core (server, web, shared): no Minecraft or the like. The domain lives in the agent and its folder; `demo/` is only a usage example.
- Images: data lives in `DOC.files` (fileId → BinaryFileData), elements only carry the `fileId`. The browser shares only files used by live images (Excalidraw keeps old ones in memory too); the server deletes the file replaced by `replace`, and at startup the ones no element uses.
- `add_image` with `path` works only for loopback MCP clients (`createMcpServer({ local })`); `/mcp` refuses everything else anyway.
- No board settings for permissions or recognition mode: Claude Code's permissions decide what runs, the policy says to ask on the board before irreversible actions, and interpretations are always confirmed. Only `effort` is left in `Settings`.
- Mermaid → Excalidraw runs in the browser (`rpc.ts`, dynamic import of `@excalidraw/mermaid-to-excalidraw`): `draw_diagram` needs an open board, like `get_board_image`.
- AI drawings tied to a node carry `customData.livingboard.nodeId`: they follow the node when it is rearranged and widen its footprint (`footprint`).
- A candidate's hash is over the elements' *content*, not their position: moving things does not trigger a re-read (`HASH_VERSION` in `board.ts` migrates old boards).
- Placement (`Drawer.place`): candidates on a grid aligned to the anchor, all around it; the cheapest free one wins: closeness + growth of the board's perimeter + distance from a screen-shaped board (against strips) + a slight right/below preference; the parts of one call without `near` stay a compact group. Without an anchor the reference is `focus()`: the latest human elements touched (`updated`). Notes go to the free spot closest to the node, no longer in the margin.
- Layout of AI drawings (`draw.ts`): existing arrows are paths (`lines`), not rectangles; `extend` scores fan/comb layouts at several distances (overlaps, arrows over text, crossings, distance) and keeps arrows straight or elbowed; `route()` (arrows of `draw`) tries straight, curved, elbow.
- Clean board by default: lens off (`livingboard:lens`), a label only on the selected idea, on the open card and on proposals still waiting for a yes (old boards: the hybrid mode is gone, interpretations are always confirmed). Bubbles and labels avoid arrows, AI drawings and other nodes (`cost()` in `Overlay.tsx`).
- AI lens on: below zoom 0.5 only big titles; relation labels from 0.7 up; views only when opened (local) or pinned (`pinned`, shared).
- Agent drawings: every call of a drawing tool = one `drawingId` in `customData.livingboard` (with `kind`, `title`, `nodeId`). `replace` deletes the old one and (for svg/tables/charts) puts the new one in its place; `erase` deletes. `board_overview.drawings` lists them.
- Human edits to the agent's drawings: `board.ts` compares their content (texts, parts, images) once they settle; moving does not count. They arrive in `wait_for_changes.drawingEdits` with `added`/`removed`. Server writes (origin `SERVER`) only update the comparison base.
- Drawn permissions (`DOC.approvals`): a request remembers the ids of its two boxes and reads them where they are now (they can be moved). Mark = a small human element whose centre is on the box (grown by 40%), still for 700ms; the latest wins. Marks stay out of segmentation (`approvalMarkIds`) and the answer arrives only once in `approvals` (a change of mind counts again).
- `delete_text`: AI text goes freely; human text only with an `approvalId` answered Yes, and if the request has `about`, only inside those elements. `match` ignores the texts of permission requests (they quote the text to delete).
- npm package vs sources: `config.ts` `BUNDLED` (esbuild `define` of `__LIVINGBOARD_BUNDLE__` = the version). Bundled: data in `~/.livingboard`, page in `<package>/web`, the CLI registers `node <package>/dist/cli.js mcp` and the hook from `dist/`. Sources: data in `data/`, tsx. Keep one bundle per entry (no esbuild `splitting`): paths are computed from `import.meta.dirname`, which must be `dist/`. The repo root is `livingboard-monorepo`, so `pnpm --filter livingboard` only picks the npm package.
- Rename from Sinapsi (2026-10-20): a little compatibility stays. A project's `.sinapsi/` folder moves to `.livingboard/` the first time it is registered (`boardsDir`); `customData.sinapsi` becomes `customData.livingboard` when a board loads (`migrateLegacyData`); the browser moves `sinapsi:*` localStorage keys (`legacy.ts`); saved views still find `window.sinapsi`.
- In a background browser pane `requestAnimationFrame` does not run: the overlay viewport stays stale until the tab is visible (false negative in tests).
