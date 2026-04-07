# Roadmap <!-- {docsify-ignore} -->

What's coming next and what's already shipped. Skalex v4 delivered the AI-first foundation: vector search, agent memory, MCP, natural language queries, and pluggable storage across every JavaScript runtime. The items below extend that foundation without adding complexity or dependencies.

---

#### Todo

**Sync & multi-device**
- [ ] Pluggable sync engine: push/pull replication with last-write-wins and custom conflict resolution; built-in adapters for REST, WebSocket, CouchDB/PouchDB, Supabase, and Firebase
- [ ] Multi-tab sync: BroadcastChannel-based cross-tab reactivity in browsers  -  writes in one tab reflect instantly in all others, zero extra dependencies
- [ ] Partial/filtered replication: sync only the documents matching a per-session or per-user filter
- [ ] Real-time collaboration: CRDT-based field-level merging for conflict-free multi-user writes; presence tracking API

**Query & schema**
- [ ] Logical query operators: `$or`, `$and`, `$not` for composable filter conditions
- [ ] Aggregation pipeline: `$group`, `$project`, `$unwind`, `$lookup` stages (MongoDB-style)
- [ ] Full-text search: tokenized inverted index for text fields; `$text` operator with ranking
- [ ] Cursor-based pagination: `after` cursor complement to existing `page`/`limit`
- [ ] Compound indexes (multi-field)
- [ ] `db.stream(query, options)`: async generator for streaming large result sets without loading the full collection into memory
- [ ] Schema change safety: detect breaking schema changes before applying; `addMigration({ dryRun: true })` for safe previewing
- [ ] Zod schema integration: pass a Zod schema to `createCollection` for validation and inference

**AI**
- [ ] Hybrid search: BM25 sparse + vector dense scoring with Reciprocal Rank Fusion  -  15–30% better recall than cosine similarity alone
- [ ] Multimodal embeddings: unified text + image vector space via compatible multimodal models (e.g. CLIP)  -  search images with natural language
- [ ] Vector quantization: scalar and product quantization for 4–8× embedding memory reduction on large datasets
- [ ] Graph-enhanced vector retrieval: traverse relationships during semantic search for contextually richer results
- [ ] Streaming LLM responses: `db.ask()` and `memory.compress()` as async iterables for real-time output
- [ ] `collection.similar(doc, options)`: find semantically near-duplicate documents via embedding distance
- [ ] `db.classify(doc, labels)`: zero-shot document classification via LLM
- [ ] `db.summarize(collection, options)`: AI-powered collection or result-set summarization
- [ ] `db.rag(query, options)`: RAG pipeline in one call  -  vector search → context assembly → LLM answer
- [ ] Strict LLM response validation: type-check and operator-validate AI-generated filters before execution; throw on malformed responses instead of silently returning empty results

**Graph**
- [ ] `collection.traverse(startId, options)`: multi-hop relationship traversal with depth, direction, and filter control  -  powers knowledge graphs, recommendations, and social graphs
- [ ] Shortest-path and neighbor queries across populated collections

**Time-series**
- [ ] `createCollection(name, { timeSeries: true })`: optimized time-ordered inserts with windowed queries and time-bucketed aggregations
- [ ] Downsampling: reduce time-series granularity for archival and charting use cases

**Security**
- [ ] Field-level encryption: encrypt individual document fields with separate keys, independent of the storage adapter
- [ ] Row-level security: per-collection access control functions evaluated at query time
- [ ] Key rotation for `EncryptedAdapter`: rekey the entire database to a new encryption key without a full decrypt/re-encrypt cycle

**Storage adapters**
- [ ] `SQLiteWASMAdapter`: browser-native SQLite via the official SQLite WASM build  -  persistent, faster than `localStorage`, no server needed
- [ ] IndexedDB adapter (browser persistent storage beyond `localStorage`)
- [ ] `PostgresAdapter`: PostgreSQL via `postgres` / `pg` Node.js driver
- [ ] `BetterSQLite3Adapter`: synchronous Node.js SQLite via `better-sqlite3`
- [ ] `RedisAdapter`: Redis as a storage and cache backend
- [ ] `MongoAdapter`: MongoDB collection as a storage backend via the official `mongodb` driver
- [ ] `BunPostgresAdapter`: Bun-native `bun:postgres` storage
- [ ] `DenoKVAdapter`: Deno KV storage for Deno Deploy persistence
- [ ] More storage adapter connectors

**Resilience & memory**
- [ ] Graceful shutdown: `db.close()` flushes all pending writes before process exit; SIGTERM / `beforeunload` handler built-in
- [ ] Write-Ahead Log (WAL): journal mutations before applying so a hard kill or OOM crash never loses committed data
- [ ] Multi-process `FsAdapter` safety: file-lock (`O_EXCL` sentinel + PID-based stale-lock detection) so multiple Node.js / Bun processes targeting the same data directory serialize writes without data loss; single-writer-per-directory remains the default, this is an opt-in `{ multiProcess: true }` flag
- [ ] `FsAdapter { durable: true }`: call `F_FULLFSYNC` (macOS) or `fsync` + directory-sync (Linux) after every rename so writes survive a sudden power failure on SSDs with write caching; off by default to preserve current performance characteristics
- [ ] `db.size(collection?)`: report per-collection and total in-memory footprint in bytes
- [ ] Memory pressure events: `db.on('memoryWarning', cb)` fires when heap usage crosses a configurable threshold  -  lets apps shed load before OOM

**DX & tooling**
- [ ] `create-skalex`: scaffolding CLI  -  `npm create skalex@latest` for instant project setup with runtime-specific templates
- [ ] Interactive playground: browser-based sandbox hosted on the docs site  -  try Skalex with zero installation
- [ ] Test utilities: `createTestDb(options?)` helper pre-configured with MemoryAdapter for frictionless unit and integration testing
- [ ] `db.rest(options)`: auto-generate a zero-configuration REST API server for all collections
- [ ] `db.graphql(options)`: auto-generate a GraphQL API with queries and mutations for all collections
- [ ] `db.compact()`: reduce on-disk file size by rewriting storage without dead or fragmented entries
- [ ] OpenTelemetry integration: `db.otel(provider)`  -  emit traces and metrics for all database operations
- [ ] Actionable error messages: every error includes a unique code, a plain-English explanation, and a suggested fix
- [ ] Prisma / Drizzle schema import: auto-generate Skalex collections from existing schema files
- [ ] `@skalex/devtools`: browser DevTools extension  -  inspect collections, run live queries, visualize schema and indexes
- [ ] `npx skalex`: CLI inspector REPL for browsing database files without writing code
- [ ] Query explain / execution plan debug tool
- [ ] Automated backup & restore
- [ ] Additional export formats (NDJSON, Parquet)

**Framework adapters**
- [ ] `skalex/react`: React hooks and context integration
- [ ] `skalex/vue`: Vue 3 composables and reactivity integration
- [ ] `skalex/svelte`: Svelte stores integration
- [ ] `skalex/solid`: SolidJS signals integration
- [ ] `skalex/eleva`: Eleva.js signals and reactive store integration

#### Done

**Build & distribution**
- [x] Full build matrix: `dist/skalex.esm.js`, `dist/skalex.esm.min.js`, `dist/skalex.cjs`, `dist/skalex.min.cjs`, `dist/skalex.browser.js` (ESM, `node:*` stubbed), `dist/skalex.umd.min.js` (IIFE, CDN default via jsDelivr / unpkg)
- [x] Connector subpackage exports: `skalex/connectors` (all adapters), `skalex/connectors/storage`, `skalex/connectors/embedding`, `skalex/connectors/llm`  -  fully tree-shakeable named exports
- [x] `node:` prefix on all built-in imports: Deno 2.x compatible

**TypeScript & testing**
- [x] Full TypeScript definitions with generics and union types
- [x] Cross-runtime smoke test suite: 787 tests verified across Node.js, Bun, Deno, and headless Chromium (ESM + UMD/IIFE CDN build)
- [x] Adapter conformance test suite: same tests against MemoryAdapter, FsAdapter (json/gz), EncryptedAdapter

**Storage adapters**
- [x] Pluggable `StorageAdapter` interface
- [x] `FsAdapter`: atomic writes, gz/json format
- [x] `LocalStorageAdapter`: browser `localStorage` support
- [x] `EncryptedAdapter`: AES-256-GCM at-rest encryption (Node ≥18, Bun, Deno, browser)
- [x] `BunSQLiteAdapter`: Bun native `bun:sqlite` storage
- [x] `D1Adapter`: Cloudflare D1 / Workers edge SQLite
- [x] `LibSQLAdapter`: LibSQL / Turso client adapter

**Query & schema**
- [x] Schema validation (`type`, `required`, `unique`, `enum`)
- [x] Unique index constraints
- [x] Strict mode: `createCollection(name, { strict: true })` rejects unknown fields
- [x] Schema error strategies: `onSchemaError: "throw" | "warn" | "strip"`
- [x] Versioned migrations with `_meta` tracking
- [x] Secondary field indexes: O(1) lookups via `IndexEngine`
- [x] Filter pre-sorter: indexes evaluated before regex/`$fn`
- [x] Full query operator support (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$fn`)
- [x] Dot-notation nested field queries
- [x] Custom search methods (`$fn`, RegExp)
- [x] `$inc` and `$push` update operators
- [x] Sorting (`sort: { field: 1 | -1 }`)
- [x] Pagination (`page` + `limit`)
- [x] Data projection (`select`)
- [x] Collection population (`populate`)
- [x] `collection.count / sum / avg / groupBy`: aggregation with filter + dot-notation

**Collections & data lifecycle**
- [x] `collection.upsert()`: update-or-insert
- [x] `collection.upsertMany(docs, matchKey)`: batch upsert
- [x] `insertOne({ ifNotExists })`: safe conditional insert
- [x] TTL documents: `_expiresAt` + connect-time sweep
- [x] Default TTL per collection: `createCollection(name, { defaultTtl: "24h" })`
- [x] Soft deletes: `createCollection(name, { softDelete: true })`, `col.restore()`, `{ includeDeleted }`
- [x] Document versioning: `createCollection(name, { versioning: true })`, auto-increments `_version`
- [x] Capped collections: `createCollection(name, { maxDocs: N })`, FIFO eviction
- [x] Default embed per collection: `createCollection(name, { defaultEmbed: "field" })`
- [x] `createdAt` and `updatedAt` auto-fields
- [x] Export to JSON/CSV

**Reactivity**
- [x] `collection.watch()`: reactive mutation observer (callback + AsyncIterableIterator)
- [x] `db.watch(callback)`: cross-collection global mutation observer

**AI**
- [x] `EmbeddingAdapter` interface: pluggable embedding backends
- [x] `OpenAIEmbeddingAdapter`: OpenAI `text-embedding-3-small` (and any model override)
- [x] `OllamaEmbeddingAdapter`: local embeddings via Ollama
- [x] `LLMAdapter` interface: pluggable language model backends
- [x] `OpenAILLMAdapter`: chat completions, default `gpt-4o-mini`
- [x] `AnthropicLLMAdapter`: messages API, default `claude-haiku-4-5`
- [x] `OllamaLLMAdapter`: local `/api/generate`, default `llama3.2`
- [x] `db.ask()`: natural language → structured filter via LLM; results cached
- [x] `db.useMemory()`: episodic agent memory (`remember`, `recall`, `context`, `compress`)

**MCP & extensibility**
- [x] `db.mcp()`: MCP server (stdio + HTTP/SSE) for Claude Desktop, Cursor, and any MCP client
- [x] Plugin system: `db.use(plugin)` pre/post hooks on all operations
- [x] Per-session stats: `db.sessionStats()` reads/writes/lastActive keyed by session ID

**Core database & config**
- [x] `db.transaction()`: snapshot + commit/rollback
- [x] `db.seed()`: fixture seeding with optional reset
- [x] `db.dump()`: full data snapshot
- [x] `db.inspect()`: collection metadata
- [x] `db.namespace()`: scoped sub-instances (inherits `ai` + `encrypt`)
- [x] `db.import()`: JSON/CSV file import
- [x] `db.schema()`: declared or inferred `{ field: type }` schema
- [x] `db.changelog()` / `db.restore()`: append-only mutation log + point-in-time restore
- [x] `db.stats()`: count, estimated size, average doc size per collection
- [x] `db.slowQueries()`: slow query log with configurable threshold and ring buffer
- [x] `db.renameCollection(from, to)`: in-memory + on-disk rename
- [x] `useCollection()` singleton caching
- [x] `autoSave` config option: persist after every write without `{ save: true }`
- [x] `ttlSweepInterval` config option: periodic TTL sweep via `setInterval`
- [x] `debug` config option
- [x] Custom `adapter` config option
- [x] `session` option on all mutations: audit trail via changelog
- [x] `crypto`-based unique ID generation
- [x] Write queue per collection: concurrent saves coalesced, never dropped
- [x] Per-collection `isSaving` flag: concurrent saves no longer blocked
- [x] Atomic save (temp-file-then-rename)

**Documentation**
- [x] Release notes
- [x] Basic documentation
