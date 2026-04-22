#!/usr/bin/env node
/**
 * verify-node-stubs.mjs - pre-build guard for the browser bundle.
 *
 * Rollup's browser build replaces `import ... from "node:*"` imports with
 * empty stubs so the bundle doesn't pull in Node built-ins. The stub list
 * in `rollup.config.js` is manually maintained. A new `node:*` import that
 * isn't in the list silently breaks the browser build with a cryptic error.
 *
 * This script walks `src/`, collects every unique `node:*` import, and
 * asserts each one is declared in the Rollup `external` array. Exits
 * non-zero with a helpful message when a module is missing.
 *
 * Wired into the release gate via `bun run verify`.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const ROLLUP_CONFIG = join(ROOT, "rollup.config.js");

/**
 * Walk a directory recursively, yielding file paths.
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && path.endsWith(".js")) yield path;
  }
}

/** Extract all `node:*` module specifiers from a file's imports. */
function extractNodeImports(contents) {
  const found = new Set();
  // Matches: import ... from "node:XXX"  |  import "node:XXX"
  //          await import("node:XXX")    |  require("node:XXX")
  const patterns = [
    /import\s+[^"']*["']node:([a-z/]+)["']/g,
    /import\s*\(\s*["']node:([a-z/]+)["']\s*\)/g,
    /require\s*\(\s*["']node:([a-z/]+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of contents.matchAll(re)) found.add(`node:${m[1]}`);
  }
  return found;
}

/** Parse the `external` array literal from rollup.config.js. */
function extractRollupExternals(configSource) {
  const m = configSource.match(/const\s+external\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error("Could not locate `external` array in rollup.config.js");
  const list = new Set();
  for (const item of m[1].matchAll(/["']([^"']+)["']/g)) list.add(item[1]);
  return list;
}

async function main() {
  const configSource = readFileSync(ROLLUP_CONFIG, "utf8");
  const declared = extractRollupExternals(configSource);

  const used = new Set();
  for await (const file of walk(SRC)) {
    const contents = readFileSync(file, "utf8");
    for (const mod of extractNodeImports(contents)) used.add(mod);
  }

  const missing = [...used].filter((m) => !declared.has(m));
  const unused = [...declared].filter((m) => !used.has(m));

  if (missing.length > 0) {
    console.error("✖ verify-node-stubs: missing entries in rollup.config.js `external` array");
    for (const m of missing) console.error(`    - ${m}`);
    console.error("");
    console.error("  Add them to the `external` array so the browser build stubs them correctly.");
    process.exit(1);
  }

  if (unused.length > 0) {
    console.error("⚠ verify-node-stubs: rollup `external` lists modules no longer imported by src/");
    for (const u of unused) console.error(`    - ${u}`);
    console.error("");
    console.error("  These can be removed from the `external` array.");
    process.exit(1);
  }

  console.log(`✔ verify-node-stubs: ${used.size} node:* imports, all declared (${[...used].sort().join(", ")})`);
}

main().catch((err) => {
  console.error(`✖ verify-node-stubs failed: ${err.message}`);
  process.exit(1);
});
