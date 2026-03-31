/**
 * MCP Agent Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Exposes a Skalex database to any MCP client — Claude Desktop, Cursor,
 * or any agent that speaks the Model Context Protocol.
 *
 * Two configurations are shown:
 *
 *   1. stdio transport  — for Claude Desktop and Cursor (default)
 *   2. HTTP/SSE transport — for browser-based or remote agents
 *
 * The server exposes these MCP tools to the agent:
 *   skalex_find        — query a collection with filters
 *   skalex_insert      — insert documents
 *   skalex_update      — update matching documents
 *   skalex_delete      — delete matching documents
 *   skalex_search      — vector similarity search
 *   skalex_ask         — natural language query
 *   skalex_schema      — inspect a collection's schema
 *   skalex_collections — list all collections
 *
 * What this covers:
 *   db.mcp(opts)                 — create an MCP server instance
 *   server.listen()              — start accepting connections
 *   scopes per collection        — read/write access control
 *   allowedOrigin                — CORS opt-in for HTTP transport
 *
 * Requirements:
 *   OPENAI_KEY env var  (for vector search + db.ask())
 *   Transport is stdio by default; set TRANSPORT=http for HTTP/SSE
 *
 * Run (stdio — for Claude Desktop):
 *   OPENAI_KEY=sk-... node index.js
 *
 * Run (HTTP/SSE — for remote agents):
 *   OPENAI_KEY=sk-... TRANSPORT=http PORT=3456 node index.js
 *
 * Claude Desktop config (add to claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "my-skalex-db": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/this/index.js"],
 *         "env": { "OPENAI_KEY": "sk-..." }
 *       }
 *     }
 *   }
 */

import Skalex from "skalex";

const TRANSPORT = process.env.TRANSPORT ?? "stdio";
const PORT      = Number(process.env.PORT ?? 3456);

if (!process.env.OPENAI_KEY) {
  console.error(
    "\nMissing OPENAI_KEY.\n" +
    "  Vector search and db.ask() will be unavailable without it.\n" +
    "  Set OPENAI_KEY=sk-... to enable all MCP tools.\n"
  );
  // Not a fatal error — the server still works for basic CRUD tools
}

// ── Database setup ────────────────────────────────────────────────────────────

const db = new Skalex({
  path: "./.db",
  ai: process.env.OPENAI_KEY
    ? {
        provider:   "openai",
        apiKey:     process.env.OPENAI_KEY,
        embedModel: "text-embedding-3-small",
        model:      "gpt-4o-mini",
      }
    : undefined,
});

// Define collections with schemas before connect() so validation is active
// when the MCP agent inserts data

db.createCollection("products", {
  schema: {
    name:     { type: "string", required: true },
    category: { type: "string", required: true, enum: ["hardware", "software", "service"] },
    price:    { type: "number", required: true },
    sku:      { type: "string", unique: true },
  },
  indexes: ["category"],
});

db.createCollection("customers", {
  schema: {
    email: { type: "string", required: true, unique: true },
    name:  { type: "string", required: true },
    tier:  { type: "string", enum: ["free", "pro", "enterprise"] },
  },
  indexes: ["tier"],
});

db.createCollection("orders", {
  schema: {
    customerId: { type: "string", required: true },
    productId:  { type: "string", required: true },
    quantity:   { type: "number", required: true },
    status:     { type: "string", required: true, enum: ["pending", "paid", "shipped", "cancelled"] },
  },
  indexes: ["customerId", "status"],
  changelog: true,
});

await db.connect();

// ── Seed some initial data so the agent has something to explore ──────────────

const products  = db.useCollection("products");
const customers = db.useCollection("customers");

if (await products.count() === 0) {
  await products.insertMany([
    { name: "Skalex Pro License",   category: "software", price: 199,  sku: "SKX-PRO" },
    { name: "Skalex Team License",  category: "software", price: 799,  sku: "SKX-TEAM" },
    { name: "Developer Console",    category: "hardware", price: 349,  sku: "DEV-CON" },
    { name: "Support Contract",     category: "service",  price: 1200, sku: "SUP-ANN" },
  ], { embed: "name" });
}

if (await customers.count() === 0) {
  await customers.insertMany([
    { name: "Alice Chen",  email: "alice@example.com",  tier: "pro" },
    { name: "Bob Torres",  email: "bob@example.com",    tier: "enterprise" },
    { name: "Carol Singh", email: "carol@example.com",  tier: "free" },
  ]);
}

// ── MCP server ────────────────────────────────────────────────────────────────

const mcpOptions = {
  transport: TRANSPORT,

  // Access control — agents can read everything but only write orders
  scopes: {
    products:  ["read"],
    customers: ["read"],
    orders:    ["read", "write"],
    "*":       ["read"],
  },
};

if (TRANSPORT === "http") {
  mcpOptions.port          = PORT;
  mcpOptions.allowedOrigin = "http://localhost:3000";  // adjust to your agent's origin
}

const server = db.mcp(mcpOptions);

// ── Start listening ───────────────────────────────────────────────────────────

if (TRANSPORT === "stdio") {
  // stdio: used by Claude Desktop and Cursor.
  // The process communicates via stdin/stdout — no network port is opened.
  // This call blocks and holds the process open.
  console.error(`[skalex-mcp] stdio transport ready`);
  await server.listen();
} else {
  // HTTP/SSE: used by remote or browser-based agents.
  await server.listen();
  console.log(`[skalex-mcp] HTTP/SSE server listening on http://localhost:${PORT}`);
  console.log(`[skalex-mcp] SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`[skalex-mcp] Collections: products, customers, orders`);
  console.log(`[skalex-mcp] Press Ctrl+C to stop.`);
}
