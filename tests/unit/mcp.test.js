/**
 * Unit tests for the SkalexMCPServer (MCP protocol + tools + access control).
 * All tests use MockTransport — no real I/O.
 */
import { describe, test, expect, beforeEach } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import MockTransport from "../helpers/MockTransport.js";

function makeDb() {
  return new Skalex({ adapter: new MemoryAdapter() });
}

async function makeServer(opts = {}) {
  const db = makeDb();
  await db.connect();
  const server = db.mcp(opts);
  const transport = new MockTransport();
  await server.connect(transport);
  return { db, server, transport };
}

// ─── MCP protocol ─────────────────────────────────────────────────────────────

describe("MCP protocol — initialize", () => {
  test("responds to initialize with protocolVersion and capabilities", async () => {
    const { transport } = await makeServer();
    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    const res = transport.lastSent();
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.capabilities).toHaveProperty("tools");
    expect(res.result.serverInfo.name).toBe("skalex");
  });

  test("responds to ping", async () => {
    const { transport } = await makeServer();
    await transport.receive({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(transport.lastSent()).toMatchObject({ id: 2, result: {} });
  });

  test("returns method-not-found for unknown methods", async () => {
    const { transport } = await makeServer();
    await transport.receive({ jsonrpc: "2.0", id: 3, method: "unknown/method" });
    expect(transport.lastSent().error.code).toBe(-32601);
  });

  test("ignores notifications (no id)", async () => {
    const { transport } = await makeServer();
    const before = transport.sent.length;
    await transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(transport.sent.length).toBe(before); // no response sent
  });
});

describe("MCP protocol — tools/list", () => {
  test("returns a list of tool definitions", async () => {
    const { transport } = await makeServer({ scopes: { "*": ["read", "write"] } });
    await transport.receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const res = transport.lastSent();
    expect(res.result.tools).toBeInstanceOf(Array);
    expect(res.result.tools.length).toBeGreaterThan(0);
    const names = res.result.tools.map(t => t.name);
    expect(names).toContain("skalex_find");
    expect(names).toContain("skalex_insert");
    expect(names).toContain("skalex_collections");
  });

  test("each tool has name, description, inputSchema", async () => {
    const { transport } = await makeServer();
    await transport.receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = transport.lastSent().result.tools;
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.inputSchema).toBe("object");
    }
  });

  test("read-only scope hides write tools", async () => {
    const { transport } = await makeServer({ scopes: { "*": ["read"] } });
    await transport.receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = transport.lastSent().result.tools.map(t => t.name);
    expect(names).toContain("skalex_find");
    expect(names).not.toContain("skalex_insert");
    expect(names).not.toContain("skalex_delete");
  });
});

// ─── MCP tools — skalex_collections ──────────────────────────────────────────

describe("skalex_collections tool", () => {
  test("returns collection names", async () => {
    const { db, transport } = await makeServer();
    await db.connect();
    db.useCollection("users");
    db.useCollection("orders");

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_collections", arguments: {} },
    });

    const text = transport.lastSent().result.content[0].text;
    const result = JSON.parse(text);
    expect(result).toContain("users");
    expect(result).toContain("orders");
  });
});

// ─── MCP tools — skalex_schema ────────────────────────────────────────────────

describe("skalex_schema tool", () => {
  test("returns schema for a collection with data", async () => {
    const { db, transport } = await makeServer();
    const col = db.useCollection("users");
    await col.insertOne({ name: "Alice", age: 30 });

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_schema", arguments: { collection: "users" } },
    });

    const result = JSON.parse(transport.lastSent().result.content[0].text);
    expect(result.name).toBe("string");
    expect(result.age).toBe("number");
  });

  test("returns null for empty collection", async () => {
    const { db, transport } = await makeServer();
    db.useCollection("empty");

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_schema", arguments: { collection: "empty" } },
    });

    const result = JSON.parse(transport.lastSent().result.content[0].text);
    expect(result).toBeNull();
  });
});

// ─── MCP tools — skalex_find ─────────────────────────────────────────────────

describe("skalex_find tool", () => {
  test("returns matching documents", async () => {
    const { db, transport } = await makeServer();
    const col = db.useCollection("users");
    await col.insertOne({ name: "Alice", role: "admin" });
    await col.insertOne({ name: "Bob",   role: "user"  });

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_find", arguments: { collection: "users", filter: { role: "admin" } } },
    });

    const result = JSON.parse(transport.lastSent().result.content[0].text);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].name).toBe("Alice");
  });

  test("returns all docs when no filter", async () => {
    const { db, transport } = await makeServer();
    const col = db.useCollection("users");
    await col.insertMany([{ name: "A" }, { name: "B" }]);

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_find", arguments: { collection: "users" } },
    });

    const result = JSON.parse(transport.lastSent().result.content[0].text);
    expect(result.docs).toHaveLength(2);
  });
});

// ─── MCP tools — skalex_insert ───────────────────────────────────────────────

describe("skalex_insert tool", () => {
  test("inserts a document and returns it", async () => {
    const { db, transport } = await makeServer({ scopes: { "*": ["read", "write"] } });
    db.useCollection("items");

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_insert", arguments: { collection: "items", doc: { name: "widget" } } },
    });

    const result = JSON.parse(transport.lastSent().result.content[0].text);
    expect(result.name).toBe("widget");
    expect(result._id).toBeDefined();
  });
});

// ─── MCP tools — skalex_update ───────────────────────────────────────────────

describe("skalex_update tool", () => {
  test("updates the first matching document", async () => {
    const { db, transport } = await makeServer({ scopes: { "*": ["read", "write"] } });
    const col = db.useCollection("items");
    const inserted = await col.insertOne({ name: "old" });

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "skalex_update",
        arguments: { collection: "items", filter: { _id: inserted._id }, update: { name: "new" } },
      },
    });

    const result = JSON.parse(transport.lastSent().result.content[0].text);
    expect(result.name).toBe("new");
  });
});

// ─── MCP tools — skalex_delete ───────────────────────────────────────────────

describe("skalex_delete tool", () => {
  test("deletes the first matching document", async () => {
    const { db, transport } = await makeServer({ scopes: { "*": ["read", "write"] } });
    const col = db.useCollection("items");
    const inserted = await col.insertOne({ name: "to-delete" });

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_delete", arguments: { collection: "items", filter: { _id: inserted._id } } },
    });

    const result = JSON.parse(transport.lastSent().result.content[0].text);
    expect(result._id).toBe(inserted._id);
    expect(await col.findOne({ _id: inserted._id })).toBeNull();
  });
});

// ─── Access control ───────────────────────────────────────────────────────────

describe("MCP access control", () => {
  test("denies write tool when scope is read-only", async () => {
    const { transport } = await makeServer({ scopes: { "*": ["read"] } });

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_insert", arguments: { collection: "items", doc: { v: 1 } } },
    });

    const content = transport.lastSent().result.content[0];
    expect(content.text).toMatch(/Access denied/);
    expect(transport.lastSent().result.isError).toBe(true);
  });

  test("allows read when scope includes read", async () => {
    const { db, transport } = await makeServer({ scopes: { "*": ["read"] } });
    db.useCollection("items");

    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_find", arguments: { collection: "items" } },
    });

    expect(transport.lastSent().result.isError).toBeUndefined();
  });

  test("collection-specific scope overrides wildcard", async () => {
    const { transport } = await makeServer({
      scopes: { "*": ["read"], "privileged": ["read", "write"] },
    });

    // Insert into privileged collection — should be allowed
    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_insert", arguments: { collection: "privileged", doc: { v: 1 } } },
    });
    expect(transport.lastSent().result.isError).toBeUndefined();
  });

  test("unknown tool returns method-not-found error", async () => {
    const { transport } = await makeServer();
    await transport.receive({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "skalex_nonexistent", arguments: {} },
    });
    expect(transport.lastSent().error?.code).toBe(-32601);
  });
});

// ─── db.mcp() factory ────────────────────────────────────────────────────────

describe("db.mcp() factory", () => {
  test("returns a SkalexMCPServer instance", () => {
    const db = makeDb();
    const server = db.mcp();
    expect(typeof server.listen).toBe("function");
    expect(typeof server.connect).toBe("function");
    expect(typeof server.close).toBe("function");
  });

  test("transport defaults to stdio", () => {
    const db = makeDb();
    const server = db.mcp();
    expect(server.transport).toBe("stdio");
  });

  test("accepts http transport option", () => {
    const db = makeDb();
    const server = db.mcp({ transport: "http", port: 9999 });
    expect(server.transport).toBe("http");
  });
});
