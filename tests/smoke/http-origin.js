/** Exercise lazy HTTP loading and origin rejection through the built MCP API. */
export default async function httpOrigin(db, assert) {
  const col = db.createCollection("http_origin");
  const server = db.mcp({ transport: "http", port: 0, scopes: { "*": ["read", "write"] } });
  await server.listen();
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "skalex_insert", arguments: { collection: "http_origin", doc: { n: 1 } } } });
    const rejected = await fetch(server.url + "/message", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body });
    assert("untrusted browser origin is rejected", rejected.status === 403);
    await rejected.text();
    assert("rejected MCP call does not mutate data", await col.count() === 0);
    const accepted = await fetch(server.url + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert("native HTTP client is accepted", accepted.status === 202);
    await accepted.text();
    for (let i = 0; i < 100 && await col.count() === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert("native MCP tool dispatch succeeds", await col.count() === 1);
  } finally { await server.close(); }
}
