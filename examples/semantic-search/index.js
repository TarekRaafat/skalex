/**
 * Semantic Document Search
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds a searchable knowledge base from a set of technical articles.
 * Demonstrates all three search modes Skalex supports:
 *
 *   1. Vector search   — find by meaning, not keywords
 *   2. Hybrid search   — vector + structured filter combined
 *   3. Similar docs    — nearest-neighbour to an existing document
 *
 * What this covers:
 *   insertMany(docs, { embed: "field" })    — auto-embed on insert
 *   collection.search(query, opts)          — cosine similarity search
 *   collection.search(query, { filter })    — hybrid: vector + structured filter
 *   collection.similar(id, opts)            — nearest-neighbour by doc ID
 *   db.embed(text)                          — raw embedding access
 *
 * Requirements:
 *   OPENAI_KEY env var  (or swap to Ollama — see config below)
 *
 * Run:
 *   OPENAI_KEY=sk-... node index.js
 *
 * Ollama alternative (local, zero cost):
 *   ollama pull nomic-embed-text
 *   node index.js   # with OLLAMA_HOST or default http://localhost:11434
 */

import Skalex from "skalex";

const USE_OLLAMA = process.env.USE_OLLAMA === "1";

if (!USE_OLLAMA && !process.env.OPENAI_KEY) {
  console.error(
    "\nMissing OPENAI_KEY.\n" +
    "  Set OPENAI_KEY=sk-... or set USE_OLLAMA=1 for local embeddings.\n"
  );
  process.exit(1);
}

const db = new Skalex({
  path: "./.db",
  ai: USE_OLLAMA
    ? { provider: "ollama", embedModel: "nomic-embed-text" }
    : { provider: "openai", apiKey: process.env.OPENAI_KEY, embedModel: "text-embedding-3-small" },
});

await db.connect();

const articles = db.useCollection("articles");

// ── Seed the knowledge base ───────────────────────────────────────────────────

// Clear any data from a previous run so results are deterministic
await articles.deleteMany({});

const docs = [
  {
    title:    "Getting Started with Skalex",
    content:  "Skalex is a zero-dependency JavaScript database. Install it with npm install skalex, call db.connect(), and you have a working database in two lines.",
    category: "tutorial",
    level:    "beginner",
  },
  {
    title:    "Vector Search Explained",
    content:  "Cosine similarity measures the angle between two embedding vectors. The smaller the angle, the more similar the meaning. Skalex computes this in-memory over all stored vectors.",
    category: "concepts",
    level:    "intermediate",
  },
  {
    title:    "Running Local LLMs with Ollama",
    content:  "Ollama lets you run embedding and language models on your own machine. Pull a model with ollama pull nomic-embed-text and point Skalex at it for zero-cost local AI.",
    category: "tutorial",
    level:    "intermediate",
  },
  {
    title:    "Agent Memory Architecture",
    content:  "AI agents need three memory types: structured (user prefs), semantic (document embeddings), and episodic (conversation history). Skalex provides all three through a single API.",
    category: "concepts",
    level:    "advanced",
  },
  {
    title:    "AES-256 Encryption at Rest",
    content:  "Skalex encrypts every file on disk using AES-256-GCM via the Web Crypto API. Pass a 64-char hex key in the encrypt option and all storage adapter writes are encrypted automatically.",
    category: "security",
    level:    "intermediate",
  },
  {
    title:    "MCP Server for AI Agents",
    content:  "The Model Context Protocol lets AI agents read and write databases without custom integration code. Skalex ships a native MCP server: db.mcp() returns a configured server ready for Claude Desktop or Cursor.",
    category: "tutorial",
    level:    "advanced",
  },
  {
    title:    "Atomic Transactions",
    content:  "db.transaction(fn) snapshots all in-memory state before your callback runs. If anything throws, every change is rolled back automatically — no manual savepoints, no error-prone cleanup.",
    category: "concepts",
    level:    "intermediate",
  },
  {
    title:    "Cloudflare Workers with D1Adapter",
    content:  "Deploy Skalex to the edge with the D1Adapter. Pass a Cloudflare D1Database binding and get the same Skalex API — find, insert, search — on the edge runtime with no server.",
    category: "deployment",
    level:    "advanced",
  },
];

console.log(`\nEmbedding ${docs.length} articles (this calls the embedding API once per doc)...\n`);

await articles.insertMany(docs, { embed: "content" });

console.log(`  ${docs.length} articles stored with embeddings.\n`);

// ── Search 1: Vector search — find by meaning ─────────────────────────────────

console.log("─── Search 1: Vector search — \"how do I set up a local database?\" ───\n");

const { docs: results1, scores: scores1 } = await articles.search(
  "how do I set up a local database?",
  { limit: 3 }
);

for (let i = 0; i < results1.length; i++) {
  console.log(`  [${scores1[i].toFixed(3)}] ${results1[i].title}`);
  console.log(`          ${results1[i].content.slice(0, 80)}...`);
}

// ── Search 2: Hybrid search — vector + structured filter ─────────────────────

console.log("\n─── Search 2: Hybrid — \"AI memory concepts\" filtered to advanced level ───\n");

const { docs: results2, scores: scores2 } = await articles.search(
  "AI memory concepts",
  {
    filter:   { level: "advanced" },   // only advanced-level articles
    limit:    3,
    minScore: 0.3,
  }
);

for (let i = 0; i < results2.length; i++) {
  console.log(`  [${scores2[i].toFixed(3)}] [${results2[i].level}] ${results2[i].title}`);
}

// ── Search 3: Nearest neighbours — similar to an existing doc ─────────────────

console.log("\n─── Search 3: Similar — docs nearest to \"MCP Server for AI Agents\" ───\n");

const source = await articles.findOne({ title: "MCP Server for AI Agents" });

const { docs: similar, scores: scores3 } = await articles.similar(
  source._id,
  { limit: 3 }
);

for (let i = 0; i < similar.length; i++) {
  console.log(`  [${scores3[i].toFixed(3)}] ${similar[i].title}`);
}

// ── Search 4: Category-filtered query ─────────────────────────────────────────

console.log("\n─── Search 4: Hybrid — \"encryption and security\" in security category ───\n");

const { docs: results4, scores: scores4 } = await articles.search(
  "encryption and security",
  { filter: { category: "security" }, limit: 3 }
);

for (let i = 0; i < results4.length; i++) {
  console.log(`  [${scores4[i].toFixed(3)}] ${results4[i].title}`);
}

await db.disconnect();

console.log("\n─── Done. ───\n");
