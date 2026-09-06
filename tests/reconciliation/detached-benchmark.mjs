/**
 * Measure shallow compatibility and opt-in read cloning.
 * Usage: bun tests/reconciliation/detached-benchmark.mjs <before> <after> <output>
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
const [before, after, output] = process.argv.slice(2);
assert(before && after && output);
const Before = (await import(pathToFileURL(resolve(before, "src/index.js")))).default;
const After = (await import(pathToFileURL(resolve(after, "src/index.js")))).default;
const profiles = {};
for (const [profile, body] of Object.entries({
  flat: { n: 1, text: "hello" },
  nested: { n: 1, nested: { tags: ["a", "b"] }, rows: Array.from({ length: 20 }, (_, n) => ({ n, text: "entry" })) },
})) {
  const samples = { before: [], after: [], clone: [] };
  const databases = {};
  try {
    for (const key of Object.keys(samples)) {
      const Class = key === "before" ? Before : After;
      const db = new Class({ adapter: new MemoryAdapter() });
      databases[key] = db;
      await db.useCollection("items").insertOne({ _id: "a", ...body });
    }
    for (let round = 0; round < 12; round++) {
      for (const key of round % 2 ? ["clone", "after", "before"] : ["before", "after", "clone"]) {
        const col = databases[key].useCollection("items");
        const options = key === "clone" ? { clone: true } : {};
        const start = performance.now();
        for (let i = 0; i < 1000; i++) assert.equal((await col.findOne({ _id: "a" }, options)).n, 1);
        if (round >= 3) samples[key].push(performance.now() - start);
      }
    }
    profiles[profile] = samples;
  } finally { await Promise.all(Object.values(databases).map(db => db.disconnect())); }
}
await writeFile(output, JSON.stringify({ before, after, runtime: process.versions.bun, conditions: "1000 findOne calls per sample; flat includes generated Dates; 3 warmup and 9 measured alternating rounds", profiles }, null, 2) + "\n");
