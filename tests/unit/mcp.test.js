/**
 * Unit tests for the SkalexMCPServer and its transports.
 *
 * Protocol + tool + access-control tests use MockTransport (no I/O).
 * Transport-layer tests exercise StdioTransport and HttpTransport
 * directly with stubbed stdin / ephemeral ports.
 * Filter-sanitization tests exercise sanitizeFilter() directly.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import MockTransport from "../helpers/MockTransport.js";
import StdioTransport from "../../src/connectors/mcp/transports/stdio.js";
import HttpTransport from "../../src/connectors/mcp/transports/http.js";
import { sanitizeFilter } from "../../src/connectors/mcp/tools.js";

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

describe("MCP protocol  -  initialize", () => {
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
    // Pin the version to the current package version so a forgotten bump
    // during a release surfaces as a test failure.
    expect(res.result.serverInfo.version).toBe("4.0.0-alpha.3");
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

describe("MCP protocol  -  tools/list", () => {
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

// ─── MCP tools  -  skalex_collections ──────────────────────────────────────────

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

// ─── MCP tools  -  skalex_schema ────────────────────────────────────────────────

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

// ─── MCP tools  -  skalex_find ─────────────────────────────────────────────────

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

// ─── MCP tools  -  skalex_insert ───────────────────────────────────────────────

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

// ─── MCP tools  -  skalex_update ───────────────────────────────────────────────

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

// ─── MCP tools  -  skalex_delete ───────────────────────────────────────────────

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

    // Insert into privileged collection  -  should be allowed
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

// ─── sanitizeFilter ────────────────────────────────────────────────────────

describe("sanitizeFilter", () => {
  test("strips $fn recursively from agent-supplied filters", () => {
    const logs = [];
    const input = {
      active: true,
      $fn: (doc) => doc.x > 1,
      $or: [
        { $fn: () => true },
        { name: "Alice" },
      ],
      nested: { $fn: () => true, v: 1 },
    };
    const out = sanitizeFilter(input, (m) => logs.push(m));
    expect(out.$fn).toBeUndefined();
    expect(out.$or[0].$fn).toBeUndefined();
    expect(out.nested.$fn).toBeUndefined();
    expect(out.nested.v).toBe(1);
    expect(out.active).toBe(true);
    expect(logs.length).toBeGreaterThanOrEqual(3);
  });

  test("enforces a max recursion depth against stack-overflow payloads", () => {
    let deep = { inner: "leaf" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => sanitizeFilter(deep)).toThrow(/nested too deeply/i);
    // Shallow filter (4 levels) passes through untouched.
    const shallow = { $or: [{ $and: [{ name: { $eq: "Alice" } }] }] };
    expect(() => sanitizeFilter(shallow)).not.toThrow();
  });
});

// ─── StdioTransport ────────────────────────────────────────────────────────

describe("StdioTransport", () => {
  let stdinBackup;
  let stdoutBackup;
  let stdin;
  let writes;

  beforeEach(() => {
    // Replace process.stdin with an EventEmitter we control. Avoid triggering
    // any `'end'` event - the real transport calls process.exit(0) on end.
    stdinBackup = process.stdin;
    stdin = new EventEmitter();
    stdin.setEncoding = () => {};
    Object.defineProperty(process, "stdin", {
      value: stdin,
      configurable: true,
      writable: true,
    });

    // Capture stdout writes instead of leaking them into test output.
    writes = [];
    stdoutBackup = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  });

  afterEach(() => {
    process.stdout.write = stdoutBackup;
    Object.defineProperty(process, "stdin", {
      value: stdinBackup,
      configurable: true,
      writable: true,
    });
  });

  test("parses a single newline-delimited message", async () => {
    const transport = new StdioTransport();
    const received = [];
    transport.onMessage(async (msg) => { received.push(msg); });
    transport.start();

    stdin.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
    // Let microtasks flush
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 1, method: "ping" });

    transport.stop();
  });

  test("handles two messages in a single chunk", async () => {
    const transport = new StdioTransport();
    const received = [];
    transport.onMessage(async (msg) => { received.push(msg); });
    transport.start();

    const chunk =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a" }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "b" }) + "\n";
    stdin.emit("data", chunk);
    await new Promise((r) => setImmediate(r));

    expect(received.map((m) => m.id)).toEqual([1, 2]);
    transport.stop();
  });

  test("reassembles a message split across two chunks", async () => {
    const transport = new StdioTransport();
    const received = [];
    transport.onMessage(async (msg) => { received.push(msg); });
    transport.start();

    const payload = JSON.stringify({ jsonrpc: "2.0", id: 42, method: "split" });
    stdin.emit("data", payload.slice(0, 10));
    stdin.emit("data", payload.slice(10) + "\n");
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(42);
    transport.stop();
  });

  test("malformed JSON triggers a PARSE_ERROR response and does not invoke handler", async () => {
    const transport = new StdioTransport();
    const received = [];
    transport.onMessage(async (msg) => { received.push(msg); });
    transport.start();

    stdin.emit("data", "{ this is not json }\n");
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
    const last = JSON.parse(writes.at(-1));
    expect(last.error).toBeDefined();
    expect(last.error.code).toBe(-32700); // PARSE_ERROR per JSON-RPC spec
    transport.stop();
  });
});

// ─── HttpTransport ─────────────────────────────────────────────────────────

describe("HttpTransport", () => {
  /** Helper: POST a string body to the transport and return { status, body }. */
  async function post(url, body, { contentLength } = {}) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": contentLength ?? Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { data += c; });
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  test("POST /message with valid JSON returns 202 and invokes the handler", async () => {
    const transport = new HttpTransport({ port: 0 });
    const received = [];
    transport.onMessage(async (msg) => { received.push(msg); });
    await transport.start();
    const { port } = transport._server.address();

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const { status } = await post(`http://127.0.0.1:${port}/message`, body);
    expect(status).toBe(202);

    // Handler runs async on req.end - wait a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(1);

    await transport.stop();
  });

  test("POST /message rejects oversized body with 413", async () => {
    const transport = new HttpTransport({ port: 0, maxBodySize: 1024 });
    const received = [];
    transport.onMessage(async (msg) => { received.push(msg); });
    await transport.start();
    const { port } = transport._server.address();

    const oversized = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", payload: "a".repeat(2000) });
    let result;
    try {
      result = await post(`http://127.0.0.1:${port}/message`, oversized);
    } catch (err) {
      // req.destroy() can surface as a client-side ECONNRESET before the
      // 413 response reaches us - that still counts as rejection.
      result = { status: err.code === "ECONNRESET" ? 413 : null };
    }
    expect(result.status).toBe(413);
    // Even if a short part of the body arrived, the handler must not run.
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(0);

    await transport.stop();
  });

  test("GET /sse serves the initial endpoint event and later broadcasts", async () => {
    const transport = new HttpTransport({ port: 0 });
    transport.onMessage(async () => {});
    await transport.start();
    const { port } = transport._server.address();

    // Open an SSE client and collect incoming chunks.
    const chunks = [];
    const req = http.request({ hostname: "127.0.0.1", port, path: "/sse", method: "GET" });
    const open = new Promise((resolve, reject) => {
      req.on("response", (res) => {
        res.setEncoding("utf8");
        res.on("data", (c) => { chunks.push(c); });
        resolve(res);
      });
      req.on("error", reject);
    });
    req.end();
    const res = await open;

    // Wait for the initial endpoint event.
    await new Promise((r) => setTimeout(r, 20));
    expect(chunks.join("")).toMatch(/event: endpoint/);
    expect(chunks.join("")).toMatch(/data: \/message/);

    // Broadcast from the server.
    chunks.length = 0;
    transport.send({ jsonrpc: "2.0", id: 7, result: "hi" });
    await new Promise((r) => setTimeout(r, 20));
    expect(chunks.join("")).toMatch(/"result":"hi"/);

    res.destroy();
    await transport.stop();
  });
});
