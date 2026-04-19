# Roadmap <!-- {docsify-ignore} -->

What's coming next and what's already shipped. Skalex v4 delivered the AI-first foundation: vector search, agent memory, MCP, natural language queries, and pluggable storage across every JavaScript runtime. The items below extend that foundation without adding complexity or dependencies.

---

#### Todo

**Sync & multi-device**
- [ ] Pluggable sync engine: push/pull replication with last-write-wins and custom conflict resolution; built-in adapters for REST, WebSocket, CouchDB/PouchDB, Supabase, and Firebase
- [ ] Multi-tab sync: BroadcastChannel-based cross-tab reactivity in browsers - writes in one tab reflect instantly in all others, zero extra dependencies
- [ ] Partial/filtered replication: sync only the documents matching a per-session or per-user filter
- [ ] Real-time collaboration: CRDT-based field-level merging for conflict-free multi-user writes; presence tracking API

**Query & schema**
- [ ] Additional query operators: `$exists`, `$type`, `$size`, `$all`, `$elemMatch` for deeper document filtering
- [ ] Aggregation pipeline: `$group`, `$project`, `$unwind`, `$lookup` stages (MongoDB-style)
- [ ] Full-text search: tokenized inverted index for text fields; `$text` operator with ranking
- [ ] Cursor-based pagination: `after` cursor complement to existing `page`/`limit`
- [ ] `db.stream(query, options)`: async generator for streaming large result sets without loading the full collection into memory
- [ ] Schema change safety: detect breaking schema changes before applying; `addMigration({ dryRun: true })` for safe previewing
- [ ] Zod schema integration: pass a Zod schema to `createCollection` for validation and inference
- [ ] Query cache invalidation on schema change: automatically clear cached natural-language filter translations when a collection's schema is modified - prevents stale filters from referencing removed or renamed fields

**AI**
- [ ] Hybrid search: BM25 sparse + vector dense scoring with Reciprocal Rank Fusion - 15-30% better recall than cosine similarity alone
- [ ] Multimodal embeddings: unified text + image vector space via compatible multimodal models (e.g. CLIP) - search images with natural language
- [ ] Vector quantization: scalar and product quantization for 4-8× embedding memory reduction on large datasets
- [ ] Graph-enhanced vector retrieval: traverse relationships during semantic search for contextually richer results
- [ ] Streaming LLM responses: `db.ask()` and `memory.compress()` as async iterables for real-time output
- [ ] `db.classify(doc, labels)`: zero-shot document classification via LLM
- [ ] `db.summarize(collection, options)`: AI-powered collection or result-set summarization
- [ ] `db.rag(query, options)`: RAG pipeline in one call - vector search → context assembly → LLM answer
- [ ] Embedding cache: deduplicate embedding API calls for repeated or similar text inputs - reduces cost and latency on AI workloads
- [ ] Strict LLM response validation: type-check and operator-validate AI-generated filters before execution; throw on malformed responses instead of silently returning empty results

**Graph**
- [ ] `collection.traverse(startId, options)`: multi-hop relationship traversal with depth, direction, and filter control - powers knowledge graphs, recommendations, and social graphs
- [ ] Shortest-path and neighbor queries across populated collections

**Time-series**
- [ ] `createCollection(name, { timeSeries: true })`: optimized time-ordered inserts with windowed queries and time-bucketed aggregations
- [ ] Downsampling: reduce time-series granularity for archival and charting use cases

**Security**
- [ ] Field-level encryption: encrypt individual document fields with separate keys, independent of the storage adapter
- [ ] Row-level security: per-collection access control functions evaluated at query time
- [ ] Key rotation for `EncryptedAdapter`: rekey the entire database to a new encryption key without a full decrypt/re-encrypt cycle
- [ ] MCP HTTP authentication: optional API key or bearer token authentication for the HTTP transport - CORS origin checking alone is insufficient for production deployments
- [ ] Linear-time ReDoS-safe `$regex` engine: Skalex currently defends against catastrophic backtracking with a length cap and a nested-quantifier heuristic in `compileRegexFilter()`. The heuristic catches common footguns like `(a+)+` but not all pathological patterns (e.g. `(a|a|a)+`, certain lookahead traps). A full guarantee would require a linear-time regex engine (RE2-style NFA or similar), which cannot be achieved with JavaScript's built-in `RegExp`. Would require a runtime dependency or a pure-JS NFA implementation; both are significant and at odds with the zero-dep constraint, so this is a long-horizon item rather than a near-term fix.

**MCP**
- [ ] Request schema validation: validate incoming JSON-RPC messages against the MCP protocol schema before dispatching - reject malformed requests at the transport level
- [ ] Rate limiting: optional per-client request throttling on the HTTP transport - prevents abuse from misconfigured clients or runaway agents
- [ ] SSE heartbeat: periodic keepalive pings on the SSE channel - detect and clean up stale connections

**Storage adapters**
- [ ] `SQLiteWASMAdapter`: browser-native SQLite via the official SQLite WASM build - persistent, faster than `localStorage`, no server needed
- [ ] IndexedDB adapter (browser persistent storage beyond `localStorage`)
- [ ] `PostgresAdapter`: PostgreSQL via `postgres` / `pg` Node.js driver
- [ ] `BetterSQLite3Adapter`: synchronous Node.js SQLite via `better-sqlite3`
- [ ] `RedisAdapter`: Redis as a storage and cache backend
- [ ] `MongoAdapter`: MongoDB collection as a storage backend via the official `mongodb` driver
- [ ] `BunPostgresAdapter`: Bun-native `bun:postgres` storage
- [ ] `DenoKVAdapter`: Deno KV storage for Deno Deploy persistence
- [ ] `DataStore` abstraction layer: introduce an interface between Collection and the raw `_data` array so the storage engine can be swapped from in-memory to disk-backed without changing the public API - prerequisite for scaling beyond in-memory limits

**Resilience & memory**
- [ ] Plugin hook timeouts: configurable timeout for `beforeHook`/`afterHook` execution in the mutation pipeline - a slow or hanging plugin should not block all database operations indefinitely
- [ ] Graceful shutdown: `db.close()` flushes all pending writes before process exit; SIGTERM / `beforeunload` handler built-in
- [ ] Write-Ahead Log (WAL): journal mutations before applying so a hard kill or OOM crash never loses committed data
- [ ] Multi-process `FsAdapter` safety: file-lock (`O_EXCL` sentinel + PID-based stale-lock detection) so multiple Node.js / Bun processes targeting the same data directory serialize writes without data loss; single-writer-per-directory remains the default, this is an opt-in `{ multiProcess: true }` flag
- [ ] `FsAdapter { durable: true }`: call `F_FULLFSYNC` (macOS) or `fsync` + directory-sync (Linux) after every rename so writes survive a sudden power failure on SSDs with write caching; off by default to preserve current performance characteristics
- [ ] `db.size(collection?)`: report per-collection and total in-memory footprint in bytes
- [ ] Memory pressure events: `db.on('memoryWarning', cb)` fires when heap usage crosses a configurable threshold - lets apps shed load before OOM
- [ ] Memory budgets with LRU eviction: configurable per-collection memory limit with least-recently-used eviction policy for long-running processes - complements `maxDocs` FIFO cap with a memory-aware alternative
- [ ] Per-collection transaction locking: replace global serialization with per-collection locks so transactions touching disjoint collections can run concurrently - significantly improves write throughput for multi-collection workloads
- [ ] Copy-on-write transaction isolation: transactional writes operate on a cloned copy; commit merges back, rollback discards - eliminates full-collection deep clone cost for large datasets
- [ ] Crash recovery beyond sentinel warning: auto-rollback to last-known-good state or programmatic recovery callback when an incomplete flush is detected on load - currently only logs a warning
- [ ] Persistence state encapsulation: move per-collection write-tracking state out of the collection store and into the persistence manager - cleaner separation of concerns

**DX & tooling**
- [ ] `[beta.1]` Fix lossy changelog restore (rehydrate raw snapshots instead of replaying through `insertOne`/`updateOne`)
- [ ] `[beta.1]` Normalize connector subpath exports (add `require`/`types` entries for all connector subpaths)
- [ ] `create-skalex`: scaffolding CLI - `npm create skalex@latest` for instant project setup with runtime-specific templates
- [ ] Interactive playground: browser-based sandbox hosted on the docs site - try Skalex with zero installation
- [ ] Test utilities: `createTestDb(options?)` helper pre-configured with MemoryAdapter for frictionless unit and integration testing
- [ ] `db.rest(options)`: auto-generate a zero-configuration REST API server for all collections
- [ ] `db.graphql(options)`: auto-generate a GraphQL API with queries and mutations for all collections
- [ ] `db.compact()`: reduce on-disk file size by rewriting storage without dead or fragmented entries
- [ ] OpenTelemetry integration: `db.otel(provider)` - emit traces and metrics for all database operations
- [ ] Actionable error messages: every error includes a unique code, a plain-English explanation, and a suggested fix
- [ ] Prisma / Drizzle schema import: auto-generate Skalex collections from existing schema files
- [ ] `@skalex/devtools`: browser DevTools extension - inspect collections, run live queries, visualize schema and indexes
- [ ] `npx skalex`: CLI inspector REPL for browsing database files without writing code
- [ ] Query explain / execution plan debug tool
- [ ] Migration rollback: `down()` migration support for reversible schema and data changes - currently only `up()` is supported with no programmatic rollback path
- [ ] Automated backup & restore
- [ ] Additional export formats (NDJSON, Parquet)
- [ ] Stress and performance test suite: benchmark hot paths (`insertOne`, `find`, `updateOne`) under load, detect memory leaks in long-running processes, and guard against performance regressions across releases
- [ ] Performance characteristics documentation: document expected throughput, latency, and memory usage for common workloads and collection sizes
- [ ] Dataset size and memory architecture guide: recommended collection sizes, index strategy for large datasets, and memory characteristics of the in-memory architecture - set clear expectations for what Skalex is designed for
- [ ] Custom serializer protocol guide: document the tagged-object convention for BigInt and Date preservation so custom serializer/deserializer implementations handle type round-trips correctly

**Framework adapters**
- [ ] `skalex/react`: React hooks and context integration
- [ ] `skalex/vue`: Vue 3 composables and reactivity integration
- [ ] `skalex/svelte`: Svelte stores integration
- [ ] `skalex/solid`: SolidJS signals integration
- [ ] `skalex/eleva`: Eleva.js signals and reactive store integration

#### Done

**[alpha.4] - 2026-04-20 - Architecture decomposition, performance, code quality**
- [x] `find()` limit-only fast path: early termination without full sort
- [x] Skip `structuredClone` for `prev` when changelog is disabled
- [x] Cache `stats()` computation with dirty flag (avoid full `JSON.stringify`)
- [x] Document `presortFilter` reliance on ES spec key-order guarantee
- [x] Extract shared `fetchWithRetry()` utility from all AI adapters (6 duplicated copies)
- [x] Convert `FsAdapter` from sync to async zlib (`deflateSync` blocks event loop)
- [x] Formalize tiered adapter capability interfaces (`StorageAdapter`, `BatchStorageAdapter`, `RawFileStorageAdapter`, `PathAwareStorageAdapter`)
- [x] D1 session-based cross-chunk atomicity: when Cloudflare's D1 Sessions API reaches GA, wrap `D1Adapter.writeAll()` chunks in a single session so failures in later chunks roll back earlier ones atomically
- [x] Tighten transaction isolation: block non-tx writes to tx-touched collections (rollback can clobber outside writes)
- [x] Add backpressure to watch event queues (`maxBufferSize` with oldest-drop)
- [x] Lazy-import `FsAdapter` for browser builds (clear error instead of cryptic stub failure)
- [x] `Symbol.toStringTag` on core classes for informative `console.log` output
- [x] `Symbol.asyncDispose` for `await using db = new Skalex(...)` (ES2024)
- [x] Extract `ICollectionContext` interface for isolated Collection testing
- [x] Align `SkalexConfig` type with runtime: add `lenientLoad`, widen logger level to include `'warn'`
- [x] Decompose `Skalex` class: extract `SkalexAI`, `TtlScheduler`, consolidate meta facade
- [x] Decompose `Collection` class: extract `VectorSearch`, `CollectionExporter`, `QueryPlanner`, `DocumentBuilder`
- [x] Complete Skalex-Collection decoupling (Collection constructor accepts `_ctx` only)

**[alpha.3] - 2026-04-11 - Runtime safety, adapter consistency, code quality, platform hardening**
- [x] Prune `_abortedIds` in `TransactionManager` with bounded pruning window (1000) - fixes unbounded memory growth on repeated timeouts
- [x] Per-instance `_idCounter` in `TransactionManager` - fixes latent cross-instance transaction ID bleed from the module-level counter
- [x] Make `_enforceCapAfterInsert()` atomic with per-doc state tracking; evicted docs emit `delete` watch events
- [x] Migration atomicity: each migration runs inside a transaction; `_meta.appliedVersions` is flushed atomically with migration data via a new `recordApplied` callback and `_txManager.snapshotIfNeeded("_meta", ...)` path
- [x] Migration API: `up(collection)` → `up(db)` (breaking change; `db.useCollection(name)` inside migration callbacks)
- [x] Fix `Memory.tokenCount()` / `context()` bypassing `ensureConnected` - now async, reads through public `find()` API
- [x] Memory session ID fail-fast validation at `useMemory(sessionId)` construction
- [x] Unify `_meta` store creation across `PersistenceManager` and `CollectionRegistry` via single `createStore()` path
- [x] Consolidate dual `_getMeta` / `_saveMeta` into `PersistenceManager.getMeta()` / `updateMeta()`
- [x] Share `_buildCollectionContext` across Collection instances (single allocation per Skalex instance)
- [x] Remove `Collection.database` property - `_ctx` is the narrow dependency surface
- [x] Extract `_isVisible(doc, includeDeleted)` soft-delete visibility helper - 7 call sites unified
- [x] Define `Ops` / `Hooks` constants (`src/engine/constants.js`) - frozen maps replace magic strings in `collection.js` and `changelog.js`
- [x] Simplify `namespace()` config forwarding - spreads stored `_config` object, new options inherit automatically
- [x] TTL sweep O(n) via filter-and-reassign (was O(n*k) with in-place splice loop)
- [x] Move orphan temp-file cleanup from `PersistenceManager` to `FsAdapter.cleanOrphans()`
- [x] `applyUpdate()` silently skips `updatedAt` - system-managed, matches `_id` / `createdAt` treatment
- [x] Document transaction isolation semantics (read-committed), timeout semantics (cooperative), nested-transaction detection (`ERR_SKALEX_TX_NESTED`)
- [x] `onSchemaError: "warn"` now logs doc `_id` + validation errors for audit trail
- [x] `deferredEffectErrors` config option + per-transaction override (`"throw"` | `"warn"` | `"ignore"`)
- [x] `$fn` / `$regex` security hardening: length cap (500) + nested-quantifier rejection applied in `matchesFilter()`, not just in `ask()`
- [x] `sanitizeFilter()` in MCP tool handlers strips `$fn` recursively and depth-caps filters at 16 levels
- [x] Document pipeline event ordering contract (events before after-hooks)
- [x] Migration idempotency guidance in JSDoc + three-tier atomicity hedge (SQL within chunk / FsAdapter narrowed window / D1 across chunks)
- [x] `TransactionOptions` type declaration (`timeout`, `deferredEffectErrors`)
- [x] Public API argument validation - `ValidationError` with `ERR_SKALEX_VALIDATION_ARG` for `null`, primitives, arrays, non-function filters
- [x] Collection name validation against path traversal (`useCollection` / `createCollection` / `useMemory`)
- [x] `throw AdapterError` on unknown LLM provider (matches `createEmbeddingAdapter` behavior)
- [x] `D1Adapter.batchSize` chunking option (default 1000, Cloudflare's documented limit) with upper-bound enforcement at construction
- [x] Typed error conversions in D1Adapter, `Memory.compress()`, MCP `_validateCollection()` (stable `ERR_SKALEX_*` codes replace bare `Error` / `TypeError`)
- [x] ESLint (flat config) + madge (`--circular`) + tsd (type-declaration validation) wired into `npm run lint`, `npm run deps:check`, `npm run types:check`, `npm run test:all`
- [x] Error classes declared in `.d.ts` (`SkalexError`, `ValidationError`, `UniqueConstraintError`, `TransactionError`, `PersistenceError`, `AdapterError`, `QueryError`)
- [x] Version drift sweep: README, llms.txt, all docs pages, MCP `SERVER_INFO`, and connector JSDoc CDN examples pinned to `4.0.0-alpha.3`
- [x] Doc examples for `addMigration` updated from `up: async (col)` to `up: async (db)` across `docs/documentation.md` and `docs/usage-examples.md`

**Build & distribution**
- [x] Full build matrix: `dist/skalex.esm.js`, `dist/skalex.esm.min.js`, `dist/skalex.cjs`, `dist/skalex.min.cjs`, `dist/skalex.browser.js` (ESM, `node:*` stubbed), `dist/skalex.umd.min.js` (IIFE, CDN default via jsDelivr / unpkg)
- [x] Connector subpackage exports: `skalex/connectors` (all adapters), `skalex/connectors/storage`, `skalex/connectors/embedding`, `skalex/connectors/llm` - fully tree-shakeable named exports
- [x] `node:` prefix on all built-in imports: Deno 2.x compatible

**TypeScript & testing**
- [x] Full TypeScript definitions with generics and union types
- [x] Cross-runtime smoke test suite: **1125 tests** verified across Node.js, Bun, Deno, and headless Chromium ESM + UMD (**229 smoke**), on top of **896 vitest unit and integration tests**
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
- [x] Logical query operators: `$or`, `$and`, `$not` for composable filter conditions
- [x] Compound indexes (multi-field): `createCollection(name, { indexes: [["field1", "field2"]] })`
- [x] Deep structural equality for plain-object filter values
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
- [x] `collection.similar(id, options)`: find nearest-neighbour documents by cosine similarity

**MCP & extensibility**
- [x] `db.mcp()`: MCP server (stdio + HTTP/SSE) for Claude Desktop, Cursor, and any MCP client
- [x] Plugin system: `db.use(plugin)` pre/post hooks on all operations
- [x] Per-session stats: `db.sessionStats()` reads/writes/lastActive keyed by session ID

**Core database & config**
- [x] `db.transaction()`: lazy copy-on-first-write snapshots, serialized execution, configurable timeout, stale proxy detection, deferred side effects
- [x] Transaction isolation: snapshot/rollback for transactional writes (non-tx writes to tx-touched collections not yet isolated - see alpha.4 #16)
- [x] Batch persistence: `saveAtomic()` with flush sentinel for crash detection
- [x] Database-level save mutex: serialized `saveAtomic` calls prevent race conditions
- [x] Typed error hierarchy: `SkalexError`, `ValidationError`, `UniqueConstraintError`, `TransactionError`, `PersistenceError`, `AdapterError`, `QueryError` with stable `ERR_SKALEX_*` codes
- [x] Named ESM exports: error types and `Collection` available as named imports from `'skalex'`
- [x] `connect()` idempotent: concurrent calls return the same promise
- [x] Migrations can use collection write APIs during `db.connect()` without deadlocking (bootstrap flag bypasses `_ensureConnected()` during the connect lifecycle)
- [x] Failed `connect()` is recoverable: `_connectPromise` cleared on failure so retries work after the underlying error clears
- [x] `lenientLoad` config option: warn instead of throw on corrupt collection files
- [x] `dump()` returns deep copies via `structuredClone` (no internal state mutation)
- [x] Base adapter classes exported from connector barrels (`StorageAdapter`, `EmbeddingAdapter`, `LLMAdapter`)
- [x] `insertMany()` preflight unique constraint check via `assertUniqueBatch()` (no ghost index entries)
- [x] `FieldIndex.update()` atomic: restore old doc on re-index failure
- [x] Persistence guarantees documented per adapter (FsAdapter, BunSQLite, D1, LibSQL)
- [x] `ChangeLog.restore()` automatically persists restored state to disk
- [x] `{ save: true }` durability: write coalescing resolves all waiters after actual disk write
- [x] Recursive prototype pollution defense in `applyUpdate()` (nested `__proto__`/`constructor`/`prototype`)
- [x] System fields (`createdAt`, `updatedAt`) enforced on insert (user values cannot overwrite)
- [x] Dot-notation index fields rejected at declaration time
- [x] `_vector` excluded from explicit `select` projections
- [x] TTL timer `.unref()` for graceful process shutdown
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
