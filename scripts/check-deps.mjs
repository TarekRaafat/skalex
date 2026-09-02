#!/usr/bin/env node
// Zero-runtime-dependency gate. Zero dependencies - node:* builtins only.
//
// Enforces the hard rule in CLAUDE.md: `npm install skalex` installs Skalex
// and nothing else. This is the automated guardrail behind the zero-dependency
// promise - the badge, the marketing, and the reason Skalex works the same on
// every runtime. A PR that adds a runtime dependency fails the build here.
//
// What counts as a runtime dependency: any package.json field that causes an
// install when a consumer runs `npm install skalex`. That is `dependencies`,
// `optionalDependencies`, and `bundledDependencies` / `bundleDependencies`.
//
// Optional storage/embedding/LLM adapters (e.g. @libsql/client) are NOT
// dependencies: they are dynamically imported and installed by the user in
// their own project. They must never appear in the install-causing fields, so
// this gate is exactly what keeps them honest. `peerDependencies` is reported
// for visibility (it does not auto-install) but not failed on.
//
// Usage: node scripts/check-deps.mjs   (part of `npm run verify`, gated in CI)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Fields that pull extra installs into a consumer's node_modules. All must be
// empty for the zero-dependency guarantee to hold.
const INSTALLING_FIELDS = ["dependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"];

const violations = [];
for (const field of INSTALLING_FIELDS) {
  const value = pkg[field];
  if (!value) continue;
  const names = Array.isArray(value) ? value : Object.keys(value);
  if (names.length > 0) violations.push({ field, names });
}

console.log("Zero-dependency gate (package.json)\n");

if (violations.length) {
  for (const v of violations) {
    console.error(`  FAIL  ${v.field}: ${v.names.join(", ")}`);
  }
  console.error(
    `\nSkalex ships zero runtime dependencies - this is a hard constraint, not a preference.\n` +
      `Reach the same result with node:* builtins and fetch, or expose the integration as an\n` +
      `optional adapter the user installs and you dynamically import (like @libsql/client).\n` +
      `Never add a runtime dependency to make a feature easier.`,
  );
  process.exit(1);
}

const peers = pkg.peerDependencies ? Object.keys(pkg.peerDependencies) : [];
if (peers.length) {
  console.log(`  ok    no install-causing dependency fields`);
  console.log(`  note  peerDependencies (not auto-installed): ${peers.join(", ")}`);
} else {
  console.log(`  ok    no runtime dependencies of any kind`);
}
console.log(`\nZero-dependency guarantee holds.`);
