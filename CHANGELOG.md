# Changelog

All notable changes to Skalex are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [4.0.0-alpha.1] - 2026-04-01

### Fixed

- **Transaction: `autoSave` suppressed during `fn()`**  -  writes no longer flush to disk mid-transaction when `autoSave: true`; the adapter is only written once on commit. (#1)
- **Transaction: `structuredClone` replaces `JSON.parse/stringify` for snapshots**  -  Date, TypedArray, Map, Set, RegExp, and other non-JSON types now survive rollback correctly. (#2)
- **Transaction: `_inTransaction` flag**  -  added to the constructor and toggled around `fn()` so `_saveIfNeeded()` in collection operations correctly detects an active transaction. (#3)
- **Transaction: event emissions and plugin after-hooks deferred until commit**  -  `watch()` observers and `after*` plugin hooks no longer fire for writes that are subsequently rolled back; they are queued and flushed atomically on commit. (#4)
- **Transaction: concurrent transactions serialised via promise-chain mutex**  -  a `_txLock` chain ensures only one transaction runs at a time, eliminating lost-update races under `Promise.all`. (#7)
- **Transaction: `db.collections` blocked inside `fn()` via Proxy**  -  direct mutations to `db.collections` bypass the snapshot; accessing the property inside a transaction callback now throws a descriptive error directing callers to `db.useCollection()`. (#11)
- **Documentation: transaction guarantees corrected**  -  replaced "atomic" / "snapshot + commit/rollback" with accurate language across README, llms.txt, docs/index.md, and docs/index.html. (#15)
- **Serializer: BigInt-safe default serializer/deserializer**  -  the default `JSON.stringify`/`JSON.parse` pair is replaced with `_serialize`/`_deserialize`, which encode BigInt as tagged objects and revive them on load; custom serializer options are unaffected. (#16)
- **Transaction: commit sequence corrected**  -  `saveData()` now runs before the side-effect queue is flushed, so `watch()` callbacks and plugin hooks observe fully persisted state. The `_inTransaction` flag is cleared after `saveData()` and before the flush, so observers can safely trigger further operations without them being re-queued.
- **Transaction: `restore()` now uses transaction helpers**  -  `restore()` was calling `_changeLog.log()` and `_eventBus.emit()` directly, bypassing the transaction queue. It now uses `_logChange()` and `_emitEvent()` so events and changelog entries are properly deferred until commit.

### Tests

- Added 13 new integration tests covering all transaction fixes: autoSave disk suppression, `_inTransaction` flag lifecycle, Date/TypedArray/Map/Set/RegExp rollback fidelity, BigInt snapshot safety and round-trip, concurrent serialisation, `db.collections` proxy guard, watch() event deferral and rollback suppression, and restore() event deferral.

---

## [4.0.0-alpha] - 2026-03-31

> **v4 is a ground-up rewrite.** Skalex is no longer just a local document store. It is now the only JavaScript database that ships vector search, agent memory, an MCP server, natural language queries, pluggable storage, and AES-256-GCM encryption in a single zero-dependency package. Runs everywhere: Node.js, Bun, Deno, browsers, edge runtimes. The entire architecture was rebuilt around AI-first use cases. If you are building an AI agent, a local-first app, or anything that needs a database without the infrastructure overhead, this is that release.
>
> **Breaking changes**: see [MIGRATION](MIGRATION.md) for upgrade instructions.

### Breaking Changes

- **Minimum Node.js version raised to `>=18.0.0`**
- **Sort direction is now MongoDB-standard**: `1` = ascending, `-1` = descending
- **`db.mcp()` defaults to read-only access**: was `{ "*": ["read", "write"] }`, now `{ "*": ["read"] }`; pass `scopes: { "*": ["read", "write"] }` to restore write access
- **`db.namespace(id)` sanitises the ID**: characters outside `[a-zA-Z0-9_-]` are replaced with `_`; if your IDs contained dots or slashes (e.g. `"tenant.001"`), rename the data directory on disk before upgrading
- **MCP HTTP CORS is opt-in**: `db.mcp({ transport: "http" })` no longer sends `Access-Control-Allow-Origin`; pass `allowedOrigin` to enable browser client access
- **`db.import()` is JSON-only**: the `format` parameter and CSV import support have been removed; the `format: "csv"` path used a naive parser that corrupted values containing commas, making round-trips with `collection.export({ format: "csv" })` unreliable

> See [MIGRATION](MIGRATION.md) for step-by-step instructions on §1 Node.js requirement, §2 sort direction, and §3 CSV import.

---

### Added

#### Constructor Options

| Option | Description |
|--------|-------------|
| `adapter` | Plug in any storage backend without changing application code |
| `encrypt: { key }` | Wrap the adapter with AES-256-GCM; accepts a 64-char hex string or 32-byte `Uint8Array` |
| `autoSave` | Persist after every write automatically, without passing `{ save: true }` per operation; default `false` |
| `ttlSweepInterval` | Interval in ms for a periodic TTL sweep; timer starts on `connect()` and stops on `disconnect()` |
| `debug` | Log connect/disconnect lifecycle events |

#### Storage & Adapters

Six pluggable backends ship out of the box; swap without changing any other code:

| Adapter | Environment |
|---------|-------------|
| `FsAdapter` | Node.js, Bun, Deno; atomic writes; `gz` (default) or `json` format |
| `LocalStorageAdapter` | Browser `localStorage` |
| `EncryptedAdapter` | Wraps any adapter with AES-256-GCM; random IV per write; zero extra dependencies |
| `BunSQLiteAdapter` | Bun-native `bun:sqlite`; `:memory:` or file path |
| `D1Adapter` | Cloudflare D1 / Workers |
| `LibSQLAdapter` | LibSQL / Turso |

#### Collection Options (`createCollection`)

New options available when defining a collection:

| Option | Description |
|--------|-------------|
| `softDelete` | Marks documents with `_deletedAt` instead of removing them; retrieve with `{ includeDeleted: true }` |
| `versioning` | Auto-increments `_version` on every insert and update |
| `strict` | Rejects documents with fields not declared in the schema |
| `onSchemaError` | `"throw"` (default) \| `"warn"` \| `"strip"`; behaviour on schema validation failure |
| `defaultTtl` | TTL applied to every inserted document automatically (e.g. `"24h"`) |
| `defaultEmbed` | Field name auto-embedded as `_vector` on every insert |
| `maxDocs` | Capped collection; oldest documents evicted FIFO when the limit is exceeded |

#### Query Engine

- **Secondary indexes**: declare `indexes: ["field"]` on `createCollection()` for O(1) lookups on any field
- **Unique constraints**: `schema: { field: { unique: true } }` enforces no-duplicate on insert and update
- **Query operators**: `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$regex` `$fn`
- **Dot-notation**: filter, sort, aggregate, and project nested fields: `{ "address.city": "Cairo" }`
- **Filter pre-sorter**: indexed and equality fields are evaluated before regex/`$fn` for maximum performance

#### Schema & Validation

- **`db.schema(collection)`**: returns a declared or inferred `{ field: type }` map for any collection
- Schema rules: `type`, `required`, `unique`, `enum`; declared on `createCollection()`

#### TTL Documents

- **`ttl` insert option**: `insertOne(doc, { ttl: "30m" | "24h" | "7d" | seconds })` sets `_expiresAt`
- Expired documents are swept on `connect()` and on every `ttlSweepInterval` tick if configured

#### Migrations

- **`db.addMigration({ version, up })`**: register versioned migration functions; pending migrations run automatically on `connect()`
- **`db.migrationStatus()`**: returns `{ current, applied, pending }`

#### Database Methods

- **`db.transaction(fn)`**: snapshots all in-memory state; rolls back automatically if `fn` throws
- **`db.seed(fixtures, { reset })`**: bulk-insert fixtures per collection; `reset: true` clears before seeding
- **`db.dump()`**: returns all user collection data as plain objects; internal system collections are excluded
- **`db.inspect([name])`**: returns `{ name, count, schema, indexes, softDelete, versioning, strict, onSchemaError, maxDocs }` per collection
- **`db.renameCollection(from, to)`**: renames a collection in memory and on disk
- **`db.namespace(id)`**: returns a scoped `Skalex` instance stored under `<path>/<id>/`; inherits all config from the parent; throws if a custom `adapter` was configured (create a separate instance instead)
- **`db.import(filePath)`**: imports a JSON array from any file path; collection name is derived from the filename
- **`db.embed(text)`**: direct access to the configured embedding adapter

#### Collection Methods

- **`collection.upsert(filter, doc)`**: updates the first matching document or inserts if none found
- **`collection.upsertMany(docs, matchKey)`**: batch upsert keyed on `matchKey`
- **`collection.restore(filter)`**: undoes a soft delete; requires `softDelete: true` on the collection
- **`insertOne` `ifNotExists` option**: `insertOne(doc, { ifNotExists: true })` returns the existing document instead of throwing on a duplicate

#### Vector Search

- **`OpenAIEmbeddingAdapter`**: OpenAI text embeddings; default model `text-embedding-3-small`
- **`OllamaEmbeddingAdapter`**: local embeddings via Ollama; default model `nomic-embed-text`
- **`ai` constructor option**: `{ provider, apiKey, embedModel, model, host }` wires both embedding and language model in one place
- **`embed` insert option**: `insertOne(doc, { embed: "fieldName" })` auto-embeds the named field as `_vector`; works on `insertMany` too
- **`collection.search(query, opts)`**: cosine similarity search; supports `filter` (hybrid search), `limit`, `minScore`
- **`collection.similar(id, opts)`**: nearest-neighbour lookup by document ID
- `_vector` is never exposed in query or search results

#### AI Query Layer

- **`OpenAILLMAdapter`**: chat completions; default model `gpt-4o-mini`
- **`AnthropicLLMAdapter`**: Messages API; default model `claude-haiku-4-5`
- **`OllamaLLMAdapter`**: local LLM via Ollama; default model `llama3.2`
- **`db.ask(collection, nlQuery, opts)`**: translates a natural language question into a structured filter via the configured LLM, then runs `find()`; results are cached by query + schema hash and survive connect/disconnect cycles

#### Agent Memory

- **`db.useMemory(sessionId)`**: returns a `Memory` instance backed by a `_memory_<sessionId>` collection
- **`memory.remember(text)`**: stores a text episode with a semantic embedding
- **`memory.recall(query, opts)`**: semantic similarity search over stored memories
- **`memory.history(opts)`**: chronological listing; supports `since` and `limit`
- **`memory.forget(id)`**: delete a memory entry by `_id`
- **`memory.context(opts)`**: returns an LLM-ready context string capped to a token budget
- **`memory.compress(opts)`**: summarises older episodes via the LLM; keeps the most recent entries intact
- **`memory.tokenCount()`**: token estimate (chars ÷ 4 heuristic)

#### ChangeLog

- **`changelog: true`** collection option: enables an append-only mutation log on the collection
- **`db.changelog()`**: returns the shared `ChangeLog` instance
- **`changelog.query(collection, opts)`**: query log entries with `since`, `limit`, `session` filters
- **`db.restore(collection, timestamp, opts)`**: replays the log to restore a collection to any past point in time; single-document restore supported via `{ _id }`

#### Events & Reactive Queries

- **`collection.watch(filter?, callback?)`**: observe mutations on a collection in real time; callback form returns an unsubscribe function; no-callback form returns an `AsyncIterableIterator`
- **`db.watch(callback)`**: global observer that fires for every mutation across all collections; event shape: `{ op, collection, doc, prev? }`

#### Aggregation

- **`collection.count(filter?)`**: document count with optional filter
- **`collection.sum(field, filter?)`**: numeric field sum; dot-notation supported
- **`collection.avg(field, filter?)`**: numeric field average
- **`collection.groupBy(field, filter?)`**: group documents by field value; returns a `{ value: docs[] }` map

#### Stats & Observability

- **`db.stats(collection?)`**: `{ collection, count, estimatedSize, avgDocSize }` per collection
- **`slowQueryLog` constructor option**: `{ threshold, maxEntries }` enables slow query recording
- **`db.slowQueries(opts?)`**: retrieve recorded slow queries; filter by `collection`, `minDuration`, `limit`
- **`db.slowQueryCount()`**: returns the number of recorded slow queries
- **`db.clearSlowQueries()`**: clears the slow query ring buffer

#### Session Stats & Tagging

- **`session` option** on all mutations and reads: tags operations for audit and per-session stat tracking
- **`db.sessionStats(sessionId?)`**: returns `{ sessionId, reads, writes, lastActive }` per session

#### Plugin System

- **`db.use(plugin)`**: register a plugin with lifecycle hooks: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `beforeFind`, `afterFind`, `beforeSearch`, `afterSearch`
- **`plugins` constructor option**: pre-register plugins at construction time
- All hooks are `async`, awaited in registration order; a throwing hook propagates the error to the caller

#### MCP Server

- **`db.mcp(opts?)`**: exposes the database as MCP tools for Claude Desktop, Cursor, and any MCP-compatible client
- **Transports**: `stdio` (default, for Claude Desktop / Cursor) and `http` (HTTP + SSE, for network clients)
- **Tools**: `skalex_collections`, `skalex_schema`, `skalex_find`, `skalex_insert`, `skalex_update`, `skalex_delete`, `skalex_search`, `skalex_ask`
- **`scopes`**: per-collection access control: `["read"]`, `["read","write"]`, or `["admin"]`; use `"*"` as a wildcard; default is `{ "*": ["read"] }` (read-only)
- **`allowedOrigin`**: opt-in CORS for browser MCP clients (HTTP transport only); default `null`
- **`maxBodySize`**: maximum POST body size in bytes for the HTTP transport (default 1 MiB); increase when inserting documents with large text fields
- **`scripts/mcp-server.js`**: ready-to-run stdio entry point for Claude Desktop / Cursor; CWD-independent

#### TypeScript

- Full generics and union types ship in the package; no `@types/` package needed
- `Collection<T>`: typed collection with inferred return shapes on all methods

#### Runtime & Packaging

- Runs in Node.js ≥18, Bun, Deno 2.x, browsers, and edge runtimes (Cloudflare Workers, etc.)
- `dist/skalex.esm.js`: ESM for Node.js, Bun, Deno
- `dist/skalex.cjs`: CommonJS for Node.js `require()`
- `dist/skalex.browser.js`: browser ESM; all `node:*` built-ins stubbed at build time
- `dist/skalex.esm.min.js` + `dist/skalex.min.cjs`: minified variants
- Subpath exports: `skalex/connectors/encrypted`, `/local`, `/d1`, `/bun-sqlite`, `/libsql`
- `skalex/min`: subpath export for minified builds

---

### Security

- **Regex denial of service**: `db.ask()` validates all LLM-generated `$regex` patterns before compilation; patterns are length-capped and those with nested quantifiers (e.g. `(a+)+`) that cause catastrophic backtracking are rejected
- **MCP system collection access**: collection names starting with `_` are blocked in all MCP tool calls; `skalex_collections` does not expose internal system collections
- **MCP HTTP request flooding**: the HTTP transport enforces a configurable POST body size limit (default 1 MiB via `maxBodySize`); oversized requests are rejected with a 413 response
- **SQL injection via table name**: the `table` option on `BunSQLiteAdapter`, `D1Adapter`, and `LibSQLAdapter` is validated against a strict identifier allowlist at construction time
- **Prototype pollution**: field names in `updateOne` / `updateMany`, dot-notation filter paths, and `groupBy` field values are hardened against `__proto__`, `constructor`, and `prototype` manipulation
- **Encryption key validation**: `EncryptedAdapter` validates the full hex key string on construction and throws immediately on invalid characters, preventing silent key weakening
- **TTL overflow**: `parseTtl()` throws on non-finite results, preventing extremely large values from silently making documents permanent
- **API error body leakage**: error response bodies from OpenAI, Anthropic, and Ollama are truncated to 200 characters before being included in thrown errors

---

## [3.2.5] - prior

- Fixed: Files Read/Write compression handling

## [3.2.4] - prior

- Fixed: Empty filter object handling

## [3.2.3] - prior

- Fixed: Empty filter object handling

## [3.2.2] - prior

- Fixed: `Collection` reference

## [3.2.1] - prior

- Fixed: `updateOne` & `updateMany` methods issue
- Updated: `update` methods for optimizations

## [3.2.0] - prior

- Added: Complete isolated and improved `fs` module
- Updated: `loadData` & `saveData` methods
- Updated: `utils` by separating `fs` related methods
- Updated: `logger` for better error logging
- Fixed: `findOne` method broken options
- Fixed: `find` method find all use-case
- Cleaned: all methods for better handling

## [3.1.0] - prior

- Added: `$inc` and `$push` operators to `updateOne` and `updateMany`
- Fixed: `saveData` format according to the set config data format

## [3.0.1] - prior

- Fixed: Broken data directory `path` reference

## [3.0.0] - prior

> Breaking changes: see [MIGRATION](MIGRATION.md) for upgrade instructions.

- Added: Find nested object values support `find({ "object.key": "value" })`
- Added: Setting collection `export` destination directory
- Changed: Setting database files directory from `string` to `object` key `{ path: "./.db" }`
- Changed: Saved default data format from `JSON` files to compressed `gz` files
- Changed: Operations `save` from method to an option for `insert`/`update`/`delete`
- Changed: `exportToCSV` method name to `export`
- Changed: `find` operation returns all docs by default; use `limit` for pagination
- Updated: Collection `export` default destination to `exports` directory under `dataDirectory`
- Updated: All `many` operations output to object key `{ docs }`
- Updated: Operations `save` to be more efficient by saving used collection instead of all
- Updated: `population` for dynamic key population
- Updated: `loadData` and `saveData` methods for improved concurrent file reads/writes
- Updated: Files & directory handling for consistent path formatting across operating systems
- Fixed: Updating index map for `updateOne` and `updateMany` operations
- Fixed: `updateMany` to save inserted updates
- Fixed: Setting `isSaving` flag in error cases while saving collections
- Cleaned: `matchesFilter` method for better readability

## [2.0.0] - prior

- Added: Pagination info on the `find` method return
- Added: Custom `logger` utility function
- Updated: `generateUniqueId` method to generate better and more unique IDs
- Updated: `createdAt` to be eligible for modification on creation
- Updated: `updatedAt` to be eligible for modification on update
- Updated: `saveData` to provide better performance without conflicts

## [1.4.1] - prior

- Fixed: `saveData` method feedback was broken

## [1.4.0] - prior

- Added: `isSaving` attribute to check if there's saving in process
- Updated: `buildIndex` method to accept external index key
- Fixed: `matchesFilter` validating `itemValue` before applying filter
- Cleaned: `saveData` method and some house keeping

## [1.3.0] - prior

- Added: `$fn` custom function as a filtering option to the `find` method
- Added: `function` option to the `find` method
- Cleaned: `Collection` class and some house keeping

## [1.2.0] - prior

- Added: `REGEX` filtering option to the `find` method
- Added: `Pagination` option to the `find` method
- Added: `Sorting` options to the `find` method
- Cleaned: Project files and some house keeping

## [1.1.4] - prior

- Fixed: Collection population of `find` method
- Added: Collection population to `findOne` method

## [1.1.3] - prior

- Updated: Library documentation

## [1.1.2] - prior

- Updated: Library documentation

## [1.1.1] - prior

- Added: Library documentation
- Added: Comprehensive code comments

## [1.1.0] - prior

- Added: `useCollection` to select used collections or create if not exists
- Added: Collections relations: one-to-one and one-to-many
- Added: `population` function to populate linked collections
- Added: `select` function to select returned record values
- Added: `createdAt` and `updatedAt` values to each record
- Cleaned: Project files and some house keeping

## [1.0.3] - prior

- Fixed: NPM package

## [1.0.2] - prior

- Fixed: NPM package

## [1.0.1] - prior

- Fixed: Library reference

## [1.0.0] - prior

- Initial release
