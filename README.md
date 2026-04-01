<img src="./docs/imgs/skalex_banner.png" alt= "skalex Logo" id="logo">

<br>

# Skalex

[![GitHub package.json version](https://img.shields.io/github/package-json/v/TarekRaafat/skalex)](https://github.com/TarekRaafat/skalex)
[![npm](https://img.shields.io/npm/v/skalex)](https://www.npmjs.com/package/skalex)
![100% Javascript](https://img.shields.io/github/languages/top/TarekRaafat/skalex?color=yellow)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue.svg)
![Yes Maintained](https://img.shields.io/badge/Maintained%3F-yes-success)
[![npm](https://img.shields.io/npm/dm/skalex?label=npm)](https://www.npmjs.com/package/skalex)
[![Open Source Love](https://badges.frapsoft.com/os/v1/open-source.svg?v=103)](https://github.com/TarekRaafat/skalex)

**AI-first · Isomorphic · Zero-dependency · Local-first**

> `Skalex` ships **vector search, agent memory, natural language queries, an MCP server, and AES-256-GCM encryption** in a single zero-dependency package — no server, no config, no external services. One `npm install skalex` on Node.js, Bun, Deno, browsers, and edge runtimes. All AI capabilities — cosine similarity search, semantic agent memory with compression, `db.ask()` NLP queries via any LLM, and a one-line MCP server for Claude Desktop and Cursor — are built into the core with zero additional dependencies.

> **Architecture + fit:** all data lives in your process's heap — `db.connect()` loads the full dataset for instant, zero-overhead access. Storage adapters control where data persists, not how much fits. Designed for single-process, local-first workloads where the dataset fits in RAM: AI agents, CLI tools, desktop apps, edge workers, offline-first apps. Not a replacement for PostgreSQL or MongoDB for large-scale, multi-process, or distributed systems.

---

## Features

**Zero overhead. Maximum reach.**
- **Zero dependencies**: install the package, nothing else. No driver, no ORM, no server process.
- **Full build matrix**: ESM, ESM minified, CJS, CJS minified, browser ESM (`dist/skalex.browser.js`, no `node:*` imports), UMD/IIFE (`dist/skalex.umd.min.js`, CDN default)
- **Runs everywhere**: Node.js ≥18, Bun, Deno 2.x, browser (Chrome/Firefox/Safari), edge runtimes; verified by a 787-test cross-runtime suite
- **Pluggable storage**: `FsAdapter` (Node), `LocalStorageAdapter` (browser), `EncryptedAdapter` (AES-256-GCM), or bring your own

**Queries that scale with your data.**
- Full operator set: `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$regex` `$fn`
- Dot-notation nested field queries
- Secondary field indexes: O(1) lookups via `IndexEngine`
- Unique constraints, filter pre-sorter for performance

**Your data stays clean.**
- Zero-dependency schema validation: `type`, `required`, `unique`, `enum`
- Strict mode: `createCollection(name, { strict: true })` rejects unknown fields; `onSchemaError: "warn" | "strip"` for softer handling
- Versioned migrations: `addMigration({ version, up })`, auto-run on `connect()`
- TTL documents: `insertOne(doc, { ttl: "30m" })`, swept on connect; `defaultTtl` per collection; `ttlSweepInterval` for live processes
- Transactions: in-memory snapshot/rollback; writes suppressed from disk during `fn()`; concurrent transactions serialised; external side effects and direct collection mutations are not rolled back
- Change log: `createCollection(name, { changelog: true })`, point-in-time restore
- Soft deletes: `createCollection(name, { softDelete: true })`, `col.restore()`, `{ includeDeleted }`
- Document versioning: `createCollection(name, { versioning: true })`, auto-increments `_version`
- Capped collections: `createCollection(name, { maxDocs: N })`, FIFO eviction

**Semantic search, built in.**
- `insertOne / insertMany` with `{ embed: "field" }`: auto-embed on insert
- `collection.search(query, { filter, limit, minScore })`: cosine similarity + hybrid
- `collection.similar(id)`: nearest-neighbour lookup
- `db.embed(text)`: direct embedding access
- Built-in adapters: **OpenAI** (`text-embedding-3-small`) and **Ollama** (local, zero cost)

**Your database speaks English.**
- `db.ask(collection, nlQuery)`: translate natural language to a filter via LLM; results cached
- `db.useMemory(sessionId)`: episodic agent memory with `remember`, `recall`, `context`, `compress`
- Built-in language model adapters: **OpenAI**, **Anthropic**, **Ollama**
- `db.schema(collection)`: infer or return declared schema as a plain object

**Know exactly what's happening.**
- `collection.count / sum / avg / groupBy`: aggregation with optional filter and dot-notation
- `db.stats(collection?)`: count, estimated size, average doc size
- `slowQueryLog` option + `db.slowQueries()`: capture slow `find` and `search` calls

**React to every change.**
- `collection.watch(filter?, callback?)`: observe mutations; callback or `AsyncIterableIterator`
- `db.watch(callback)`: cross-collection global observer; fires for every mutation across all collections
- Events: `{ op, collection, doc, prev? }` emitted after every insert, update, delete, restore

**AI agents, natively wired.**
- `db.mcp(opts)`: expose the database as MCP tools for AI agents
- Compatible with **Claude Desktop**, **Cursor**, and any MCP client
- `stdio` transport (default) and `http + SSE` transport
- Tools: `find`, `insert`, `update`, `delete`, `search`, `ask`, `schema`, `collections`
- Access control: `scopes` map per collection; `read` / `write` / `admin`

**Extend anything.**
- `db.use(plugin)`: register pre/post hooks on all operations
- Hooks: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `beforeFind`, `afterFind`, `beforeSearch`, `afterSearch`
- All hooks awaited in order; errors propagate to the caller

**Full visibility per session.**
- `db.sessionStats(sessionId?)`: reads, writes, lastActive per session
- `session` option on all reads and writes: automatic accumulation

**Deploy anywhere.**
- `D1Adapter`: Cloudflare D1 / Workers edge SQLite
- `BunSQLiteAdapter`: Bun-native `bun:sqlite`; `:memory:` or file path
- `LibSQLAdapter`: LibSQL / Turso client adapter

**Built for developers who value their time.**
- `db.transaction(fn)`: in-memory snapshot/rollback; writes serialised and suppressed from disk until `fn()` resolves
- `db.seed(fixtures)`: idempotent fixture seeding
- `db.dump()` / `db.inspect()`: snapshot and metadata
- `db.namespace(id)`: isolated sub-instances per tenant / user
- `db.import(path)`: JSON import; collection name derived from filename
- `db.renameCollection(from, to)`: in-memory + on-disk rename
- `collection.upsert()`, `collection.upsertMany(docs, matchKey)`, `insertOne({ ifNotExists })`: safe idempotent writes
- `autoSave: true`: persist after every write without `{ save: true }` on every call
- `encrypt: { key }`: AES-256-GCM at-rest encryption, transparent to all callers
- `session` option on all reads and writes: audit trail + session stats
- `debug: true`: connect/disconnect logging

---

## Installation

```bash
npm install skalex@alpha
```

> **v4.0.0-alpha is the current release.** `npm install skalex` installs the last stable v3 — use `@alpha` to get v4.

Requires **Node.js ≥ 18**.

**Or via CDN** (no bundler, no npm — browser direct):

**ESM** — recommended for real browser apps; connectors import alongside Skalex:

```html
<script type="module">
  import Skalex from "https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha/dist/skalex.browser.js";
  import { LocalStorageAdapter } from "https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha/src/connectors/storage/browser.js";
  // browser.js also exports EncryptedAdapter for AES-256-GCM at-rest encryption

  const db = new Skalex({ adapter: new LocalStorageAdapter({ namespace: "myapp" }) });
  await db.connect();
</script>
```

With npm + bundler, use the connectors subpackage:

```js
import Skalex from 'skalex';
// Scoped barrels (tree-shakeable, recommended)
import { FsAdapter, LocalStorageAdapter, EncryptedAdapter,
         BunSQLiteAdapter, D1Adapter, LibSQLAdapter }       from 'skalex/connectors/storage';
import { OpenAIEmbeddingAdapter, OllamaEmbeddingAdapter }   from 'skalex/connectors/embedding';
import { OpenAILLMAdapter, AnthropicLLMAdapter,
         OllamaLLMAdapter }                                 from 'skalex/connectors/llm';
// Or pull everything from the root barrel
import { FsAdapter, OpenAIEmbeddingAdapter, OpenAILLMAdapter } from 'skalex/connectors';
```

**IIFE** — exposes `window.Skalex`, for quick demos or environments that can't use ESM:

```html
<!-- jsDelivr (recommended) -->
<script src="https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha"></script>

<!-- unpkg -->
<script src="https://unpkg.com/skalex@4.0.0-alpha"></script>
```

---

## Quick Start — 30 seconds to a working database

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data", format: "json" });
await db.connect();

const users = db.useCollection("users");

const alice    = await users.insertOne({ name: "Alice", role: "admin" });
const { docs }        = await users.find({ role: "admin" });
await users.updateOne({ name: "Alice" }, { score: { $inc: 10 } });
await users.deleteOne({ name: "Alice" });

await db.disconnect();
```

### With Vector Search

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  ai: { provider: "openai", apiKey: process.env.OPENAI_KEY },
});
await db.connect();

const articles = db.useCollection("articles");

await articles.insertMany([
  { title: "Intro to Skalex", content: "A zero-dependency JS database..." },
  { title: "Vector search 101", content: "Cosine similarity measures angle between vectors..." },
], { embed: "content" });

const { docs, scores } = await articles.search("how do I set up a JS database?", { limit: 2 });
console.log(docs[0].title); // most relevant result

await db.disconnect();
```

---

## Documentation

Everything you need to go from zero to production:

**[tarekraafat.github.io/skalex](https://tarekraafat.github.io/skalex/)** :notebook_with_decorative_cover:

See what's shipping next: **[Roadmap](https://tarekraafat.github.io/skalex/#/roadmap)**

---

## Support

- Stack Overflow: [stackoverflow.com/questions/tagged/skalex][stackOverflow]
- GitHub Discussions: [github.com/TarekRaafat/skalex/discussions][Discussions]

<!-- section links -->
[Discussions]: https://github.com/TarekRaafat/skalex/discussions
[stackoverflow]: https://stackoverflow.com/questions/tagged/skalex

---

## Author

**Tarek Raafat**

- Email: tarek.m.raafat@gmail.com
- Github: [github.com/TarekRaafat](https://github.com/TarekRaafat/)

---

## License

Released under the [Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0).

© 2026 [Tarek Raafat](http://www.tarekraafat.com)
