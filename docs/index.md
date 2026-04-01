<div class="cover">

<div>
<img src="./imgs/skalex_banner.png" alt= "Skalex Logo" id="logo">

<br>

![100% Javascript](https://img.shields.io/github/languages/top/TarekRaafat/skalex?color=yellow)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue.svg)
[![npm](https://img.shields.io/npm/dm/skalex?label=npm)](https://www.npmjs.com/package/skalex)
[![Yes Maintained](https://img.shields.io/badge/Maintained%3F-yes-success)](https://github.com/TarekRaafat/skalex)
[![Open Source Love](https://badges.frapsoft.com/os/v1/open-source.svg?v=103)](https://github.com/TarekRaafat/skalex)

<div class="sharethis-inline-share-buttons"></div>

<a href="#/?id=skalex" class="link no-underline"><span class="ps-icon ps-icon-down"></span></a>

</div>

</div>

---

# Skalex <!-- {docsify-ignore} -->

> No server. No config. No dependencies. The AI-first JavaScript database  -  built for AI agents, local-first apps, and every JavaScript runtime. :rocket:

> [!WARNING]
> **v4.0.0-alpha**: this is a pre-release. The API may change before the stable `4.0.0` release. Pin the exact version in your `package.json` and review the [CHANGELOG](https://github.com/TarekRaafat/skalex/blob/master/CHANGELOG.md) before upgrading.

## What is Skalex? <!-- {docsify-ignore} -->

`Skalex` ships **vector search, agent memory, natural language queries, an MCP server, and AES-256-GCM encryption** in a single zero-dependency package  -  no server, no infrastructure, no external services. One `npm install skalex@alpha` on Node.js, Bun, Deno, browsers, and edge runtimes.

**What sets it apart:** all AI capabilities are built into the core. Vector search with cosine similarity, semantic agent memory with compression, `db.ask()` natural language queries via any LLM, and a one-line MCP server for Claude Desktop and Cursor  -  not plugins, not external services, not additional dependencies. OpenAI and Ollama adapters ship in the box.

**How it works:** all data lives in your process's heap. `db.connect()` loads the dataset into memory for instant, zero-overhead access  -  no connection pool, no round trips, no cold starts. Storage adapters control where data persists and how it is reloaded.

**Built for:** single-process, local-first workloads  -  AI agents, CLI tools, desktop apps, edge workers, and offline-first apps  -  where the dataset fits in memory.

**Not the right fit for:** multi-process or distributed deployments, high write concurrency across many clients, or datasets that exceed available RAM. For those, PostgreSQL, MongoDB, or SQLite are better choices.

## Features <!-- {docsify-ignore} -->

**AI capabilities:**
- Vector search: cosine similarity + hybrid filter support via `collection.search()`
- Agent memory: `db.useMemory()` episodic store with semantic recall, context, and compression
- Natural language queries: `db.ask()` translates plain English to structured filters via any LLM
- MCP server: `db.mcp()` exposes the database as tools to Claude Desktop, Cursor, and any MCP client
- Embedding adapters: OpenAI (`text-embedding-3-small`) and Ollama (local, zero API cost) ship in the box
- LLM adapters: OpenAI, Anthropic, and Ollama  -  configurable at construction time
- At-rest encryption: AES-256-GCM via `EncryptedAdapter`, transparent to all callers

**Zero overhead. Maximum reach:**
- Pure Vanilla JavaScript: zero runtime dependencies
- Isomorphic: Node.js ≥18, Bun, Deno 2.x, browsers, edge runtimes
- Full build matrix ships in the box: `dist/skalex.esm.js`, `dist/skalex.esm.min.js`, `dist/skalex.cjs`, `dist/skalex.min.cjs`, `dist/skalex.browser.js`, `dist/skalex.umd.min.js`
- CDN-ready  -  **ESM** (recommended): `skalex.browser.js` + `src/connectors/storage/browser.js` → `{ LocalStorageAdapter, EncryptedAdapter }`; **IIFE** (quick demos): `<script src="https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha.1"></script>` → `window.Skalex`
- npm + bundler: `import { FsAdapter, LocalStorageAdapter, EncryptedAdapter, OpenAIEmbeddingAdapter, OllamaEmbeddingAdapter, OpenAILLMAdapter, AnthropicLLMAdapter, OllamaLLMAdapter } from 'skalex/connectors'`  -  single subpackage, fully tree-shakeable; scoped: `skalex/connectors/storage`, `skalex/connectors/embedding`, `skalex/connectors/llm`
- Full TypeScript definitions with generics and union types; no `@types/` package needed
- Pluggable connectors: storage (`FsAdapter`, `LocalStorageAdapter`, `EncryptedAdapter`, `BunSQLiteAdapter`, `D1Adapter`, `LibSQLAdapter`), embedding (`OpenAIEmbeddingAdapter`, `OllamaEmbeddingAdapter`), LLM (`OpenAILLMAdapter`, `AnthropicLLMAdapter`, `OllamaLLMAdapter`)

**Queries and data integrity:**
- All CRUD operations <sub><sup>(Create, Read, Update, Delete)</sub></sup>
- Query operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$fn`
- Dot-notation nested field queries
- Secondary field indexes: O(1) lookups; indexed fields evaluated first automatically
- Unique index constraints
- Schema validation: `type`, `required`, `unique`, `enum` rules
- Relational collections <sub><sup>(populate: one-to-one & one-to-many)</sub></sup>

**Data lifecycle:**
- TTL documents: auto-expiry with `_expiresAt`; `defaultTtl` per collection; `ttlSweepInterval` for live processes
- Versioned migrations: `addMigration({ version, up })`, auto-run on `connect()`
- Transactions: in-memory snapshot/rollback; writes suppressed from disk during `fn()`; concurrent transactions serialised; external side effects and direct collection mutations are not rolled back
- Soft deletes: `createCollection(name, { softDelete: true })`, `col.restore()`, `{ includeDeleted }`
- Document versioning: auto-increments `_version` on every write
- Capped collections: `createCollection(name, { maxDocs: N })`, FIFO eviction
- Append-only changelog: `db.changelog()` with point-in-time restore

**Observability and extensibility:**
- Aggregation: `count`, `sum`, `avg`, `groupBy` with filter and dot-notation support
- Reactive collections: `collection.watch()` with callback and `AsyncIterableIterator` forms
- Global observer: `db.watch(callback)` fires for every mutation across all collections
- Slow query log: configurable threshold and ring buffer
- Per-session stats: `db.sessionStats()` reads/writes/lastActive per session
- Plugin system: `db.use(plugin)` pre/post hooks on all operations

<details>
<summary>How it works under the hood</summary>

<br>

1. **Storage that goes anywhere:**
   - All I/O routes through a `StorageAdapter` interface. Swap `FsAdapter` for `LocalStorageAdapter` to move from Node.js to the browser. Swap again for D1, LibSQL, or Bun SQLite to hit the edge. Zero code changes in your application layer.
2. **Connect once, start immediately:**
   - No server process, no config file, no schema migration to run. `await db.connect()` loads your data. Everything else just works.
3. **Queries that don't slow you down:**
   - Declare indexed fields on `createCollection()` and every matching query runs in O(1). Mark fields `unique: true` to enforce constraints automatically  -  no extra validation code needed.
4. **Bad data never makes it in:**
   - Define schemas with type checking, required fields, enum constraints, and unique rules. Validation runs at insert and update time with descriptive error messages  -  before anything touches storage.
5. **Data that cleans itself:**
   - Pass `ttl: '30m'` on any insert and the document expires automatically. No cron jobs, no cleanup scripts, no stale data.
6. **Migrations that run themselves:**
   - Register versioned migration functions with `db.addMigration({ version, up })`. They run automatically on `connect()` in the correct order, once, and never again.
7. **Transactions with no boilerplate:**
   - `db.transaction(fn)` snapshots all in-memory state before your callback runs. If anything throws, every change rolls back. No manual savepoints, no error-prone cleanup.
8. **Relations without a query language:**
   - Link collections via `populate` on `find`/`findOne`. One-to-one and one-to-many relationships resolve in a single call.
9. **Queries as expressive as your data:**
   - Filter with plain objects, operators (`$gt`, `$in`, `$regex`), dot-notation for nested fields, or custom `$fn` functions. Indexed fields are evaluated first, automatically.
10. **Data in, data out, any format:**
    - Export filtered collection data to JSON or CSV. Import JSON files back in. Works through any storage adapter.

</details>


## What's next <!-- {docsify-ignore} -->

Hybrid search, CRDT collaboration, graph traversal, time-series collections, new storage adapters, and more  -  see the full [Roadmap](roadmap.md).

## Author <!-- {docsify-ignore} -->

<div class="ps-icon ps-icon-guy-big-smile"></div> <b>Tarek Raafat</b>

- Email: tarek.m.raafat@gmail.com
- Github: [github.com/TarekRaafat](https://github.com/TarekRaafat/)

## License <!-- {docsify-ignore} -->

`Skalex` is released under the [Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0).

© {{year}} [Tarek Raafat](http://www.tarekraafat.com)
