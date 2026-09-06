import Skalex from "../../dist/skalex.esm.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

/** Browser-generated Origin headers must gate mutations, not just response reads. */
export default async function browserHttpOrigin(page, pageOrigin) {
  for (const allowed of [false, true]) {
    const db = new Skalex({ adapter: new MemoryAdapter() });
    await db.connect();
    const col = db.createCollection("browser_http");
    const server = db.mcp({ transport: "http", port: 0, allowedOrigin: allowed ? pageOrigin : null, scopes: { "*": ["read", "write"] } });
    await server.listen();
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "skalex_insert", arguments: { collection: "browser_http", doc: { n: 1 } } } });
      await page.evaluate(async ({ url, body, allowed }) => {
        const response = await fetch(url, { method: "POST", mode: allowed ? "cors" : "no-cors", headers: { "Content-Type": "text/plain" }, body });
        await response.text();
      }, { url: server.url + "/message", body, allowed });
      if (allowed) for (let i = 0; i < 100 && await col.count() === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
      const count = await col.count();
      if (count !== (allowed ? 1 : 0)) throw new Error("Browser origin dispatch mismatch: " + count);
      console.log("  ✓ browser HTTP origin " + (allowed ? "allowed" : "rejected before mutation"));
    } finally { await server.close(); }
  }
}
