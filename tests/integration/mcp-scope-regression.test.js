import { describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import MockTransport from "../helpers/MockTransport.js";

describe("MCP authorization uses the executed collection name", () => {
  test.each(["skalex_find", "skalex_schema", "skalex_insert", "skalex_update", "skalex_delete", "skalex_search", "skalex_ask"])("denies padded protected collection for %s", async name => {
    const db = new Skalex({ adapter: new MemoryAdapter() });
    await db.connect();
    await db.useCollection("secret").insertOne({ _id: "s", value: "private" });
    const transport = new MockTransport();
    const server = db.mcp({ scopes: { "*": ["read", "write"], secret: [] } });
    await server.connect(transport);
    await transport.receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name, arguments: { collection: " secret ", filter: {}, doc: { value: "added" }, update: { value: "changed" }, query: "x", question: "x" },
    } });
    const response = transport.lastSent().result;
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Access denied");
    expect((await db.useCollection("secret").find({})).docs.map(d => d.value)).toEqual(["private"]);
    await db.disconnect();
  });

  test("permits padded names only when their canonical collection is authorized", async () => {
    const db = new Skalex({ adapter: new MemoryAdapter() });
    await db.connect();
    await db.useCollection("allowed").insertOne({ _id: "a" });
    const transport = new MockTransport();
    const server = db.mcp({ scopes: { allowed: ["read"] } });
    await server.connect(transport);
    await transport.receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "skalex_find", arguments: { collection: " allowed " },
    } });
    expect(JSON.parse(transport.lastSent().result.content[0].text).docs[0]._id).toBe("a");
    await db.disconnect();
  });
});
