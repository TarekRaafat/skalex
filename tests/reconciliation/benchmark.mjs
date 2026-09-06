/**
 * Alternating before/after microbenchmarks for the contained insert fix.
 * Usage: bun tests/reconciliation/benchmark.mjs <baseline-root> <fixed-root> <output>
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
const [beforeRoot, afterRoot, output] = process.argv.slice(2);
const variants = {};
for (const [name, root] of Object.entries({ before: beforeRoot, after: afterRoot })) {
  variants[name] = (await import(pathToFileURL(resolve(root, "src/index.js")))).default;
}
const samples = { before: [], after: [] };
for (let round = 0; round < 12; round++) {
  for (const name of round % 2 ? ["after", "before"] : ["before", "after"]) {
    const db = new variants[name]({ adapter: new MemoryAdapter() });
    await db.connect();
    const col = db.useCollection("bench");
    let start = performance.now();
    for (let i = 0; i < 10000; i++) await col.insertOne({ _id: String(i), n: i });
    const insertMs = performance.now() - start;
    start = performance.now();
    for (let i = 0; i < 1000; i++) await col.findOne({ _id: String(i) });
    const findMs = performance.now() - start;
    start = performance.now();
    for (let i = 0; i < 1000; i++) await col.updateOne({ _id: String(i) }, { n: { $inc: 1 } });
    const updateMs = performance.now() - start;
    if (round >= 3) samples[name].push({ insertMs, findMs, updateMs });
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const medians = {};
for (const name of Object.keys(samples)) {
  medians[name] = Object.fromEntries(["insertMs", "findMs", "updateMs"].map(key => [key, median(samples[name].map(s => s[key]))]));
}
const report = { runtime: process.versions, beforeRoot, afterRoot, counts: { insert: 10000, find: 1000, update: 1000 }, medians, samples };
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(medians, null, 2));
