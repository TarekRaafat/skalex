#!/usr/bin/env node
// Hard bundle-size gate. Zero dependencies - node:* builtins only.
//
// Reads size-budget.json, gzips each published artifact, and fails (exit 1)
// if any artifact exceeds its budget. This is the automated guardrail behind
// the "minimal footprint" hard rule in CLAUDE.md: the published bundle does
// not grow past its budget without a deliberate, reviewed budget bump.
//
// Usage:
//   node scripts/check-size.mjs            check dist against the budget (CI gate)
//   node scripts/check-size.mjs --update   rewrite the budget to current sizes + headroom
//
// The gate measures gzip bytes because that is what a consumer actually
// downloads. Run `npm run build` first - the check reads the built dist/.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const budgetPath = join(root, "size-budget.json");
const update = process.argv.includes("--update");

// Headroom applied by --update so trivial, noise-level diffs do not fail the
// gate. A real feature that adds weight must clear this margin, which forces a
// conscious `--update` with a rationale in the PR rather than silent creep.
const HEADROOM = 0.03;

const kb = (n) => `${(n / 1024).toFixed(2)} KB`;
const roundUp = (n, step) => Math.ceil(n / step) * step;

const gzipOf = (file) => {
  const abs = join(root, file);
  if (!existsSync(abs)) {
    console.error(`error: ${file} not found. Run \`npm run build\` first.`);
    process.exit(1);
  }
  return gzipSync(readFileSync(abs), { level: 9 }).length;
};

const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
const rows = budget.artifacts.map((a) => {
  const gzip = gzipOf(a.file);
  return { ...a, gzip, delta: gzip - a.gzipMax, over: gzip > a.gzipMax };
});

if (update) {
  for (const r of rows) {
    r.gzipMax = roundUp(Math.ceil(r.gzip * (1 + HEADROOM)), 100);
  }
  budget.artifacts = rows.map(({ file, gzipMax }) => ({ file, gzipMax }));
  writeFileSync(budgetPath, JSON.stringify(budget, null, 2) + "\n");
  console.log("Updated size-budget.json:");
  for (const r of rows) {
    console.log(`  ${r.file.padEnd(28)} ${kb(r.gzip)} gzip -> budget ${kb(r.gzipMax)}`);
  }
  console.log("\nCommit this with a rationale for the size change.");
  process.exit(0);
}

const pad = Math.max(...rows.map((r) => r.file.length));
console.log(`Bundle-size gate (gzip, budget: size-budget.json)\n`);
console.log(`  ${"artifact".padEnd(pad)}   current    budget     headroom`);
for (const r of rows) {
  const mark = r.over ? "FAIL" : "ok";
  const head = r.over ? `+${kb(r.delta)} over` : `${kb(-r.delta)} left`;
  console.log(`  ${r.file.padEnd(pad)}   ${kb(r.gzip).padStart(8)}   ${kb(r.gzipMax).padStart(8)}   ${head.padStart(12)}  ${mark}`);
}

const failures = rows.filter((r) => r.over);
if (failures.length) {
  console.error(
    `\n${failures.length} artifact(s) over budget. Either trim the change, or - if the ` +
      `growth is justified - run \`npm run size -- --update\` and explain the increase in the PR.`,
  );
  process.exit(1);
}
console.log(`\nAll artifacts within budget.`);
