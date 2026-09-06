/**
 * Compare accepted HTTP request latency across two source revisions.
 * Run: bun tests/reconciliation/http-origin-benchmark.mjs <before> <after> <output>
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
const [before, after, output] = process.argv.slice(2);
assert(before && after && output);
const variants = {};
for (const [label, root] of Object.entries({ before, after })) {
  variants[label] = (await import(pathToFileURL(resolve(root, "src/connectors/mcp/transports/http.js")))).default;
}
const samples = { before: [], after: [] };
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
for (let round = 0; round < 12; round++) {
  for (const label of round % 2 ? ["after", "before"] : ["before", "after"]) {
    const transport = new variants[label]({ port: 0, allowedOrigin: "https://app.example" });
    transport.onMessage(async () => {});
    await transport.start();
    const url = "http://127.0.0.1:" + transport._server.address().port + "/message";
    try {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        const response = await fetch(url, { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json" }, body });
        assert.equal(response.status, 202);
        await response.text();
      }
      if (round >= 3) samples[label].push(performance.now() - start);
    } finally { await transport.stop(); }
  }
}
await writeFile(output, JSON.stringify({ before, after, runtime: process.versions.bun, warmupRounds: 3, measuredRounds: 9, conditions: "Milliseconds per 100 sequential loopback POSTs with a configured Origin; startup excluded.", samples }, null, 2) + "\n");
