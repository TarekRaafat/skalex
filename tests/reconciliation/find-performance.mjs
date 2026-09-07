/**
 * Compare built ESM find calls with and without registered hooks.
 * Usage: bun tests/reconciliation/find-performance.mjs <before-entry> <after-entry> <output>
 * Node requires --expose-gc. Connection, setup and persistence are outside timing.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const [beforeEntry, afterEntry, output] = process.argv.slice(2);
assert(beforeEntry && afterEntry && output, "Pass two built ESM entry paths and an output path");
assert(globalThis.Bun?.gc || globalThis.gc, "Use Bun or node --expose-gc");
const entries = { before: beforeEntry, after: afterEntry };
const variants = {};
const hashes = {};
for (const [name, entry] of Object.entries(entries)) {
  variants[name] = (await import(pathToFileURL(entry))).default;
  hashes[name] = createHash("sha256").update(await readFile(entry)).digest("hex");
}
const report = {
  entries, hashes, runtime: process.version, bun: process.versions.bun,
  count: 50000, warmups: 5, rounds: 11,
  conditions: "Built ESM, 1000 indexed documents, one matching result, limit 1, alternating order, full GC before samples, no timed persistence",
  workloads: {},
};
for (const registered of [false, true]) {
  const samples = { before: [], after: [] };
  for (let round = 0; round < 16; round++) {
    for (const name of round % 2 ? ["after", "before"] : ["before", "after"]) {
      if (globalThis.Bun) globalThis.Bun.gc(true);
      else globalThis.gc();
      const db = new variants[name]({ adapter: new MemoryAdapter() });
      await db.connect();
      try {
        const col = db.createCollection("items", { indexes: ["n"] });
        await col.insertMany(Array.from({ length: 1000 }, (_, n) => ({ _id: String(n), n })));
        let hookCalls = 0;
        if (registered) db.use({ beforeFind() { hookCalls++; }, afterFind() { hookCalls++; } });
        let found = 0;
        const start = performance.now();
        for (let i = 0; i < report.count; i++) {
          const result = await col.find({ n: 500 }, { limit: 1 });
          if (result.docs.length === 1 && result.docs[0]._id === "500") found++;
        }
        const elapsed = performance.now() - start;
        assert.equal(found, report.count);
        assert.equal(hookCalls, registered ? report.count * 2 : 0);
        if (round >= report.warmups) samples[name].push(elapsed);
      } finally {
        await db.disconnect();
      }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values)]));
  report.workloads[registered ? "registered" : "empty"] = { medians, samples };
  console.log(registered ? "registered" : "empty", JSON.stringify(medians));
}
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
