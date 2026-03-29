# Changelog

All notable changes to Skalex are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [4.0.0-alpha] — 2026-03-29

> **Breaking changes** — see `MIGRATION.md` for upgrade instructions.

### Breaking Changes
- `insertOne()` now returns `{ data: document }` instead of the raw document
- `updateOne()` now returns `{ data: document }` instead of the raw document
- `deleteOne()` now returns `{ data: document }` instead of the raw document
- `updateMany()` now always returns `{ docs: [] }` when no matches found — never bare `[]`
- Minimum Node.js version raised to `>=18.0.0`
- `package.json` `main`/`module`/`types`/`exports` now point to `dist/`
- Sort direction convention updated to MongoDB standard — `1` = ascending, `-1` = descending

### Added

#### Architecture
- **Dual build** — `dist/skalex.esm.js` + `dist/skalex.cjs.js` + `dist/skalex.d.ts` via Rollup
- **`StorageAdapter` interface** — abstract base (`read/write/delete/list`) for all backends
- **`FsAdapter`** — Node.js file-system backend with atomic rename writes and gz/json format support
- **`LocalStorageAdapter`** — browser `localStorage` backend with `skalex:<ns>:<name>` key prefixing
- **`adapter` config option** — pass a custom `StorageAdapter` to target any environment (browser, edge, Bun)
- **`rollup.config.js`** + **`vitest.config.js`** — build and test tooling

#### Query Engine
- **`IndexEngine`** — secondary field indexes with O(1) `lookup()` via `Map<value, Set<doc>>`
- **Unique index enforcement** — schema `unique: true` throws on duplicate insert/update
- **`presortFilter()`** — evaluates indexed and equality fields before regex/`$fn` for performance
- **Full query operator support** — `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$fn`

#### Schema & Validation
- **`parseSchema()` + `validateDoc()`** — zero-dependency schema validation with `type`, `required`, `unique`, `enum`
- **`inferSchema()`** — infer a schema from a sample document

#### TTL & Migrations
- **TTL documents** — `insertOne(doc, { ttl: "30m" })` sets `_expiresAt`; expired docs swept on `connect()`
- **`MigrationEngine`** — `addMigration({ version, up })` with `_meta` state tracking; pending migrations run on `connect()`
- **`db.migrationStatus()`** — reports applied vs pending migration versions

#### Database Methods
- **`db.transaction(fn)`** — snapshot + commit/rollback; rolls back all in-memory state on error
- **`db.seed(fixtures, { reset })`** — seed collections from fixtures; optional clear before seed
- **`db.dump()`** — snapshot of all collection data as plain arrays
- **`db.inspect([name])`** — metadata per collection: doc count, schema, index list
- **`db.namespace(id)`** — scoped `Skalex` instance storing data under a sub-directory
- **`db.import(filePath, format)`** — import JSON or CSV from a file path
- **`debug: true`** config option — enables connect/disconnect log output

#### Collection Methods
- **`collection.upsert(filter, doc)`** — update if match found, insert otherwise
- **`insertOne(doc, { ifNotExists })`** — return existing doc instead of inserting duplicate
- **`updatedAt`** field set at creation time by `insertOne` and `insertMany`

#### Vector Search
- **`EmbeddingAdapter` interface** — abstract base (`embed(text) → number[]`) for all embedding backends
- **`OpenAIEmbeddingAdapter`** — OpenAI embeddings via `fetch`; default model `text-embedding-3-small`
- **`OllamaEmbeddingAdapter`** — local embeddings via Ollama; default model `nomic-embed-text`
- **`ai` constructor option** — `{ provider, apiKey, embedModel, model, host }` wires embedding + language model adapters
- **`db.embed(text)`** — direct access to the configured embedding adapter
- **`insertOne` / `insertMany` `embed` option** — field name or function selector; auto-embeds on insert, stores as `_vector`
- **`collection.search(query, opts)`** — cosine similarity search over all documents with a `_vector` field; supports `filter` (hybrid), `limit`, `minScore`
- **`collection.similar(id, opts)`** — nearest-neighbour lookup for an existing document; supports `limit`, `minScore`
- **`src/vector.js`** — `cosineSimilarity(a, b)` and `stripVector(doc)` utilities
- **`_vector` field** stripped from all `find`, `findOne`, `search`, `similar`, `insertOne`, and `insertMany` results — never exposed to callers
- **`namespace()` inherits `ai` + `encrypt` config** — namespaced instances share the same adapters

#### AI Query Layer
- **`AIAdapter` interface** — abstract base (`generate(schema, nlQuery)`, `summarize(texts)`) for language model backends
- **`OpenAIAIAdapter`** — chat completions with `json_object` response format; default model `gpt-4o-mini`
- **`AnthropicAIAdapter`** — messages API with markdown-fence stripping; default model `claude-haiku-4-5`
- **`OllamaAIAdapter`** — local `/api/generate` with `format: "json"`; default model `llama3.2`
- **`db.ask(collection, nlQuery, opts)`** — translate natural language to a filter via the language model; results cached by djb2 hash of `{ collection, schema, query }`
- **`db.schema(collection)`** — returns declared or inferred `{ field: type }` schema for any collection
- **`QueryCache`** — `set/get/toJSON/fromJSON`; persisted in `_meta` across connect/disconnect cycles
- **`processLLMFilter(filter)`** — converts `$regex` strings → `RegExp`, ISO date strings in range operators → `Date`
- **`validateLLMFilter(filter, schema)`** — warns on unknown fields; non-throwing

#### Agent Memory
- **`Memory` class** — per-session episodic store backed by `_memory_<sessionId>` collection
- **`memory.remember(text)`** — stores text with embedding for semantic recall
- **`memory.recall(query, opts)`** — semantic search over stored memories
- **`memory.history(opts)`** — chronological listing with optional `since`/`limit`
- **`memory.forget(id)`** — delete a memory entry by `_id`
- **`memory.tokenCount()`** — token estimate (chars ÷ 4 heuristic)
- **`memory.context(opts)`** — LLM-ready string capped to a token budget, newest-first selection
- **`memory.compress(opts)`** — summarises old memories via `_aiAdapter`; keeps 10 most recent intact
- **`db.useMemory(sessionId)`** — factory returning a `Memory` instance

#### ChangeLog
- **`ChangeLog` class** — append-only mutation log stored in `_changelog` collection
- **`createCollection` `changelog: true` option** — enables per-collection mutation logging
- **`changelog.log(op, collection, doc, prev, session)`** — records `insert`, `update`, `delete` with timestamp
- **`changelog.query(collection, opts)`** — query entries with `since`, `limit`, `session` filters
- **`changelog.restore(collection, timestamp, opts)`** — replays log entries to rebuild state at a point in time; supports single-doc `{ _id }` restore
- **`db.changelog()`** — returns the shared `ChangeLog` instance
- **`db.restore(collection, timestamp, opts)`** — convenience wrapper for `changelog.restore()`

#### Encryption
- **`EncryptedAdapter`** — wraps any `StorageAdapter` with AES-256-GCM; transparent to callers
- **Algorithm**: AES-256-GCM via `globalThis.crypto.subtle` — Node ≥18, Bun, Deno, and all modern browsers; zero extra dependencies
- **Wire format**: `base64(iv[12] | ciphertext + authTag[16])` — random IV per write, 128-bit authentication tag
- **`encrypt: { key }` constructor option** — 64-char hex string or 32-byte `Uint8Array`; wraps `FsAdapter` transparently
- **`namespace()` inherits `encrypt` config** — all namespaced instances share the same encryption key

#### Docs & Testing
- **Vitest test suite** — 239 tests across `tests/unit/` + `tests/integration/`; all I/O mocked via `MemoryAdapter`
- **Full v4 TypeScript definitions** — `src/index.d.ts` updated with `AIAdapter`, `EncryptedAdapter`, `Memory`, `ChangeLog`, `EncryptConfig`, `ChangeLogEntry`, and all new API surface
- **`CHANGELOG.md`** (this file)
- **`AUDIT.md`** — Phase 0 audit log documenting all 19 fixes with before/after line references
- **`MIGRATION.md`** — upgrade guide for v3 → v4 breaking changes
- **`ARCHITECTURE.md`** — internal design reference covering all v4 + Phase 3 decisions
- **`MockEmbeddingAdapter`** test helper — deterministic 4-dim vectors, call log for assertions
- **`MockAIAdapter`** test helper — configurable `nlQuery → filter` map, `calls[]` + `summarizeCalls[]` logs

### Fixed
- `findOne()` returned the raw document instead of the projected `newItem` — populate and select options were silently discarded
- `matchesFilter()` short-circuited on the first key — multi-condition AND filters never evaluated beyond the first condition
- Function filters evaluated as empty-object match due to `instanceof Object` check ordering
- `$in` and `$nin` operators were semantically inverted and crashed on non-array field values
- `$inc` in `applyUpdate()` modified a local variable and never wrote back — increments were silently lost
- `$push` in `applyUpdate()` same write-back bug — pushed to a local copy
- `applyUpdate()` set `updatedAt` inside the field loop — once per field instead of once per update call
- `applyUpdate()` contained dead `Object.assign(item, item)` no-op (removed)
- `isSaving` was a single database-level flag — concurrent saves of different collections were silently dropped
- `isSaving` was not reset via `finally` — an unhandled error could lock the database permanently
- `writeFile()` double-serialised JSON — files were written as a string-within-a-string
- `findOne()` ignored the `_id` Map index — performed O(2n) scan instead of O(1) lookup
- Nested key traversal in `matchesFilter()` crashed on null/undefined intermediate values
- Nested key traversal falsely skipped values of `0`, `""`, `false`
- `collection.js` imported native `fs` and `path` — broke non-Node environments and bypassed the storage adapter
- `useCollection()` created a new `Collection` instance on every call — state could not be reliably attached
- `loadData()` silently swallowed all errors — corrupt files were indistinguishable from missing files
- `export()` and `saveData()` caught errors but did not re-throw — callers could not detect failure

### Updated
- `src/collection.js` and `src/index.js` fully rewritten to wire all new modules
- `Collection` internal state renamed: `this.data` → `this._data`, `this.index` → `this._index`
- `useCollection()` now caches and returns the same `Collection` instance; cache cleared on `disconnect()`
- `export()` routes through the storage adapter — no more direct `fs`/`path` imports in `collection.js`
- `generateUniqueId()` now uses `crypto.randomBytes` (Node) / `crypto.getRandomValues` (browser)
- `filesys.js` class renamed from `fs` to `FileSystem` — no longer shadows the Node built-in

---

## [3.2.5] — prior

- Fixed: Files Read/Write compression handling

## [3.2.4] — prior

- Fixed: Empty filter object handling

## [3.2.3] — prior

- Fixed: Empty filter object handling

## [3.2.2] — prior

- Fixed: `Collection` reference

## [3.2.1] — prior

- Fixed: `updateOne` & `updateMany` methods issue
- Updated: `update` methods for optimizations

## [3.2.0] — prior

- Added: Complete isolated and improved `fs` module
- Updated: `loadData` & `saveData` methods
- Fixed: `findOne` method broken options
- Fixed: `find` method find all use-case

## [3.1.0] — prior

- Added: `$inc` and `$push` operators to `updateOne` and `updateMany`
- Fixed: `saveData` format according to the set config data format

## [3.0.1] — prior

- Fixed: Broken data directory `path` reference

## [3.0.0] — prior

- Breaking changes — see docs/release-notes.md for details
