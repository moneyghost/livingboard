/**
 * Builds the `livingboard` npm package from the workspace:
 *
 *   dist/cli.js, dist/server.js   packages/server bundled (shared and every dependency
 *                                 included: the package installs with no dependencies)
 *   dist/livingboard-hook.mjs     the Claude Code prompt hook, as is
 *   web/                          the built board page (packages/web/dist)
 *   README.md, LICENSE            from the repo root
 *
 * Run `pnpm build` at the repo root first (it builds the page), or use `pnpm pack:npm` there.
 */
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const repo = join(here, "..", "..");
const server = join(repo, "packages", "server");
const page = join(repo, "packages", "web", "dist");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

if (!existsSync(join(page, "index.html"))) {
  console.error("✗ packages/web/dist is missing: run `pnpm build` at the repo root first.");
  process.exit(1);
}

for (const dir of ["dist", "web"]) rmSync(join(here, dir), { recursive: true, force: true });

await build({
  entryPoints: { cli: join(server, "src", "cli.ts"), server: join(server, "src", "index.ts") },
  outdir: join(here, "dist"),
  bundle: true,
  // No shared chunks: the code finds web/ and its sibling files from its own folder (dist/).
  format: "esm",
  platform: "node",
  target: "node22",
  // Optional native speed-ups of `ws`: absent is fine.
  external: ["bufferutil", "utf-8-validate"],
  define: { __LIVINGBOARD_BUNDLE__: JSON.stringify(version) },
  // Bundled CommonJS dependencies still call require() for Node built-ins.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __lbRequire } from 'node:module';\nconst require = __lbRequire(import.meta.url);" },
  legalComments: "linked",
  logLevel: "warning",
});

cpSync(join(server, "bin", "livingboard-hook.mjs"), join(here, "dist", "livingboard-hook.mjs"));
cpSync(page, join(here, "web"), { recursive: true });
for (const f of ["README.md", "LICENSE"]) cpSync(join(repo, f), join(here, f));
console.log(`✓ livingboard ${version}: dist/ + web/ ready`);
