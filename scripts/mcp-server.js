/**
 * Skalex MCP Server  -  stdio transport
 *
 * Exposes a Skalex database as an MCP server for use with
 * Claude Desktop, Cursor, OpenClaw, or any MCP-compatible client.
 *
 * Usage (Claude Desktop / Cursor mcpServers config):
 *   {
 *     "skalex": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/scripts/mcp-server.js"]
 *     }
 *   }
 *
 * Or run directly:
 *   node scripts/mcp-server.js
 */

import Skalex from "../src/index.js";
import { fileURLToPath } from "node:url";
import { join, dirname }  from "node:path";

// ─── Connect ─────────────────────────────────────────────────────────────────

// Use an absolute path so the server works regardless of what directory
// Claude Desktop / Cursor sets as the working directory when spawning this process.
const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Skalex({ path: join(__dirname, "../mcp-data"), format: "json" });
await db.connect();

// ─── Seed demo data (first run only) ─────────────────────────────────────────

const products = db.useCollection("products");
if ((await products.count()) === 0) {
  await products.insertMany([
    { name: "Widget",    price:  9.99, category: "tools"       },
    { name: "Gadget",    price: 49.99, category: "electronics" },
    { name: "Doohickey", price:  4.99, category: "tools"       },
    { name: "Thingamajig", price: 19.99, category: "misc"      },
  ]);
}

const users = db.useCollection("users");
if ((await users.count()) === 0) {
  await users.insertMany([
    { name: "Alice", role: "admin",  email: "alice@example.com" },
    { name: "Bob",   role: "editor", email: "bob@example.com"   },
  ]);
}

// ─── Start MCP server ────────────────────────────────────────────────────────

const server = db.mcp({
  transport: "stdio",
  scopes: {
    // grant full read+write access to all collections
    "*": ["read", "write"],
  },
});

await server.listen();
