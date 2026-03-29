# Skalex v4 — Architecture

> Internal reference for contributors and future phases. Describes every design decision made during the v4 rewrite.

---

## Table of Contents

1. [Directory Layout](#1-directory-layout)
2. [Design Principles](#2-design-principles)
3. [Module Responsibilities](#3-module-responsibilities)
4. [Document Shape](#4-document-shape)
5. [Return Shapes](#5-return-shapes)
6. [Storage Adapter Interface](#6-storage-adapter-interface)
7. [Collection Store Object](#7-collection-store-object)
8. [IndexEngine](#8-indexengine)
9. [Query Engine](#9-query-engine)
10. [Schema Validator](#10-schema-validator)
11. [TTL Engine](#11-ttl-engine)
12. [MigrationEngine](#12-migrationengine)
13. [Transaction Mechanism](#13-transaction-mechanism)
14. [Auto-Connect](#14-auto-connect)
15. [Namespace](#15-namespace)
16. [Build Pipeline](#16-build-pipeline)
17. [Test Strategy](#17-test-strategy)
18. [Phase 0 Bug Fixes](#18-phase-0-bug-fixes)
19. [Embedding Adapter Interface](#19-embedding-adapter-interface)
20. [Vector Storage & Stripping](#20-vector-storage--stripping)
21. [Vector Search Engine](#21-vector-search-engine)

---

## 1. Directory Layout

```
src/
  index.js                  — Skalex class (database entry point)
  collection.js             — Collection class (per-collection CRUD)
  query.js                  — matchesFilter + presortFilter
  indexes.js                — IndexEngine (secondary field indexes)
  validator.js              — parseSchema, validateDoc, inferSchema
  ttl.js                    — parseTtl, computeExpiry, sweep
  migrations.js             — MigrationEngine
  vector.js                 — cosineSimilarity, stripVector
  utils.js                  — generateUniqueId, logger
  filesys.js                — legacy file-system helpers (v3 remnant, unused in v4 core)
  adapters/
    storage/
      base.js               — StorageAdapter abstract class
      fs.js                 — FsAdapter (Node.js file system)
      local.js              — LocalStorageAdapter (browser)
    embedding/
      base.js               — EmbeddingAdapter abstract class
      openai.js             — OpenAIEmbeddingAdapter (text-embedding-3-small default)
      ollama.js             — OllamaEmbeddingAdapter (nomic-embed-text default)

dist/
  skalex.esm.js             — ESM build (readable)
  skalex.esm.min.js         — ESM build (minified)
  skalex.cjs.js             — CJS build (readable)
  skalex.cjs.min.js         — CJS build (minified)
  skalex.d.ts               — TypeScript declarations (copied from src/index.d.ts)

tests/
  helpers/
    MemoryAdapter.js        — In-memory StorageAdapter for CI (no I/O)
  unit/
    query.test.js
    indexes.test.js
    validator.test.js
    ttl.test.js
    migrations.test.js
  integration/
    skalex.test.js
```

---

## 2. Design Principles

1. **Zero dependencies in core** — the structured store, query engine, schema validator, TTL, and migrations install nothing. `devDependencies` only.
2. **Adapter-isolated I/O** — no module in `src/` imports `fs` or `localStorage` directly. All I/O is routed through the injected `StorageAdapter`.
3. **CJS source, dual dist** — source files use `require()`/`module.exports` for broadest Node.js compatibility. Rollup produces both ESM and CJS dist artifacts for consumers.
4. **In-memory first** — all data lives in plain JS arrays and Maps. The storage adapter is only called on `connect()`, `disconnect()`, and explicit `saveData()` calls (or when `{ save: true }` is passed to a mutation).
5. **Auto-connect** — the first operation on a `Skalex` instance automatically calls `connect()` if it hasn't been called yet. `connect()` is idempotent-safe via a shared promise (`_autoConnectPromise`).
6. **Per-collection concurrency guard** — each collection store has its own `isSaving` flag. Concurrent saves to different collections are independent and do not block each other.
7. **Consistent return shapes** — `insertOne`/`updateOne`/`deleteOne` return `{ data: doc }` or `null`. `insertMany`/`updateMany`/`deleteMany`/`find` return `{ docs: [] }`. `find` with `limit` additionally includes `{ page, totalDocs, totalPages }`.

---

## 3. Module Responsibilities

| Module | Responsibility |
|---|---|
| `index.js` | Lifecycle (`connect`/`disconnect`), collection registry, migrations, transactions, seeding, namespaces, import/export orchestration, debug logging |
| `collection.js` | All CRUD operations, upsert, find with sort/pagination/populate/select, export, index maintenance around mutations |
| `query.js` | Filter evaluation (`matchesFilter`) and filter key ordering (`presortFilter`) |
| `indexes.js` | Secondary field indexes — `Map<value, Set<doc>>` for regular fields, `Map<value, doc>` for unique fields |
| `validator.js` | Schema parsing, document validation, schema inference from a sample document |
| `ttl.js` | TTL string/number parsing, expiry computation, expired-document sweep |
| `migrations.js` | Migration registration, version ordering, pending-migration execution, status reporting |
| `vector.js` | `cosineSimilarity(a, b)` — dot-product cosine; `stripVector(doc)` — shallow copy minus `_vector` |
| `utils.js` | `generateUniqueId()` (24-char timestamp + random), `logger()` (stderr wrapper) |
| `adapters/storage/base.js` | Abstract `StorageAdapter` class — defines the `read/write/delete/list` interface |
| `adapters/storage/fs.js` | Node.js adapter — gz-compressed or raw JSON files, atomic temp-then-rename writes |
| `adapters/storage/local.js` | Browser adapter — `localStorage` with namespaced keys |
| `adapters/embedding/base.js` | Abstract `EmbeddingAdapter` class — defines the `embed(text) → number[]` interface |
| `adapters/embedding/openai.js` | OpenAI adapter — `POST /v1/embeddings` via native `fetch`; default `text-embedding-3-small` |
| `adapters/embedding/ollama.js` | Ollama adapter — `POST /api/embeddings` on a local server; default `nomic-embed-text` |

---

## 4. Document Shape

Every document stored by Skalex has the following reserved fields:

| Field | Type | Set by |
|---|---|---|
| `_id` | `string` (24 chars) | `insertOne` / `insertMany` |
| `createdAt` | `Date` | `insertOne` / `insertMany` |
| `updatedAt` | `Date` | `insertOne` / `insertMany` / `applyUpdate` |
| `_expiresAt` | `Date` \| `undefined` | `insertOne` / `insertMany` when `{ ttl }` is provided |

User-supplied fields spread after `_id`, `createdAt`, `updatedAt` — user values override the defaults only for `_id` (allowing caller-supplied IDs).

---

## 5. Return Shapes

All mutation and query methods return plain objects. No raw documents are returned directly.

| Method | Success return | Not-found return |
|---|---|---|
| `insertOne` | `{ data: doc }` | — |
| `insertMany` | `{ docs: doc[] }` | — |
| `updateOne` | `{ data: doc }` | `null` |
| `updateMany` | `{ docs: doc[] }` | `{ docs: [] }` |
| `deleteOne` | `{ data: doc }` | `null` |
| `deleteMany` | `{ docs: doc[] }` | `{ docs: [] }` |
| `findOne` | `doc` (projected copy) | `null` |
| `find` (no limit) | `{ docs: doc[] }` | `{ docs: [] }` |
| `find` (with limit) | `{ docs, page, totalDocs, totalPages }` | same, empty `docs` |
| `upsert` | `{ data: doc }` | — (always inserts or updates) |

---

## 6. Storage Adapter Interface

All storage backends implement the `StorageAdapter` abstract class from `src/adapters/storage/base.js`:

```js
class StorageAdapter {
  async read(name)         // → string | null
  async write(name, data)  // → void
  async delete(name)       // → void
  async list()             // → string[]
}
```

`name` is a plain collection identifier (no path separators). The adapter maps it to whatever its storage scheme requires (file path, localStorage key prefix, etc.).

`FsAdapter` additionally exposes helpers used by `Collection.export` and `Skalex.import`:

```js
join(dir, file)            // path.join equivalent
ensureDir(dir)             // mkdir -p equivalent (sync)
async writeRaw(path, data) // write raw string to an arbitrary path
async readRaw(path)        // read raw string from an arbitrary path
```

These are not part of the `StorageAdapter` contract — they are `FsAdapter`-specific and guarded by duck-typing at the call site.

### Writing a custom adapter

Extend `StorageAdapter` and pass the instance to the constructor:

```js
import { StorageAdapter } from "skalex";
import Skalex from "skalex";

class MyAdapter extends StorageAdapter {
  async read(name) { ... }
  async write(name, data) { ... }
  async delete(name) { ... }
  async list() { ... }
}

const db = new Skalex({ adapter: new MyAdapter() });
```

---

## 7. Collection Store Object

`Skalex.collections[name]` is a plain object — the single source of truth for a collection's in-memory state:

```js
{
  collectionName: string,
  data:           object[],          // ordered array of all documents
  index:          Map<_id, doc>,     // O(1) _id lookup
  isSaving:       boolean,           // per-collection write lock
  schema:         { fields: Map, uniqueFields: string[] } | null,
  fieldIndex:     IndexEngine | null,
}
```

`Collection` instances hold a reference to this object (`this._store`) and expose it via getters (`_data`, `_index`, `_fieldIndex`, `_schema`). Multiple `Collection` instances for the same name share the same store object — mutations are immediately visible across references.

---

## 8. IndexEngine

File: `src/indexes.js`

Maintains two parallel index structures for declared fields:

```
_fieldIndexes: Map<field, Map<value, Set<doc>>>   — non-unique + unique
_uniqueIndexes: Map<field, Map<value, doc>>        — unique fields only
```

**Lookup**: `O(1)` — `_fieldIndexes.get(field).get(value)` returns the `Set` of matching documents.

**Unique enforcement**: On `add()` and `update()`, `_checkUnique()` verifies that no other document already holds the same value for a unique field. Throws `"Unique constraint violation: field X value Y already exists"` on conflict.

**Update lifecycle**: `collection.updateOne/updateMany` calls `fieldIndex.remove(oldDoc)` before `applyUpdate()` and `fieldIndex.add(newDoc)` after, so the index always reflects the post-update value.

**Build from data**: `buildFromData(data[])` rebuilds all indexes from scratch — used after `loadData()` and after a transaction rollback.

**Unique fields are also field-indexed**: A unique field gets an entry in both `_fieldIndexes` (for O(1) lookup) and `_uniqueIndexes` (for constraint checking).

---

## 9. Query Engine

File: `src/query.js`

### `matchesFilter(item, filter)`

Evaluation order (short-circuits on first `false`):

1. **Function filter** — `if (typeof filter === "function") return filter(item)` — checked **before** the empty-filter guard because functions are `instanceof Object` with zero enumerable keys, which would otherwise match the empty-filter branch.
2. **Empty filter** — `{}` matches everything.
3. **AND over all keys** — every key in the filter must pass.

Per-key logic:

| Filter value type | Evaluation |
|---|---|
| `RegExp` | `filterValue.test(String(itemValue))` |
| Object with `$`-keys | Operator dispatch: `$eq $ne $gt $gte $lt $lte $in $nin $regex $fn` |
| Anything else | Strict equality `itemValue === filterValue` |

Dot-notation keys (`"address.city"`) are resolved by splitting on `.` and reducing through the document.

### `presortFilter(filter, indexedFields)`

Reorders filter keys for optimal short-circuit evaluation:

1. **Indexed fields** — O(1) lookup, handled by `_getCandidates` before `matchesFilter` even runs
2. **Plain equality** — fast strict comparison
3. **Range operators** — `$gt $gte $lt $lte $ne $in $nin`
4. **Expensive** — `$regex $fn` and `RegExp` values

Returns a new object with keys in this order. Called in `find()` before the main scan loop.

---

## 10. Schema Validator

File: `src/validator.js`

### `parseSchema(schema)`

Normalises a user-supplied schema definition into an internal form:

```js
// Input
{ name: "string", email: { type: "string", unique: true, required: true } }

// Output
{
  fields: Map<string, { type, required, unique, enum? }>,
  uniqueFields: string[]
}
```

Supported types: `"string"`, `"number"`, `"boolean"`, `"object"`, `"array"`, `"date"`, `"any"`.

### `validateDoc(doc, fields)`

Checks a document against the parsed `fields` Map. Returns an array of error strings (empty = valid). Checks:

- **Required**: field is `undefined` or `null` when `required: true`
- **Type**: uses `typeof`, with special handling for `Array` → `"array"` and `Date` → `"date"`
- **Enum**: value must be in the allowed list

### `inferSchema(doc)`

Derives a simple `{ field: type }` schema from a sample document. Skips fields starting with `_`. Used by `db.inspect()`.

---

## 11. TTL Engine

File: `src/ttl.js`

### TTL formats accepted by `parseTtl(ttl)`

| Input | Meaning |
|---|---|
| `300` (number) | 300 seconds |
| `"300ms"` | 300 milliseconds |
| `"30m"` | 30 minutes |
| `"24h"` | 24 hours |
| `"7d"` | 7 days |

All values are converted to milliseconds internally.

### `computeExpiry(ttl)`

Returns `new Date(Date.now() + parseTtl(ttl))`. Stored as `_expiresAt` on the document.

### `sweep(data, idIndex, removeFromIndexes?)`

Called during `connect()` for every collection. Iterates the data array backwards (safe splice), removes any document where `_expiresAt <= Date.now()`, deletes from the `_id` Map index, and optionally calls `IndexEngine.remove`. Returns the count of removed documents.

---

## 12. MigrationEngine

File: `src/migrations.js`

Migrations are registered via `db.addMigration({ version, description?, up })` and stored sorted by version. On `connect()`:

1. `_getMeta()` reads applied versions from the `_meta` collection.
2. `MigrationEngine.run()` filters to pending versions and calls `up(collection)` for each in order.
3. `_saveMeta()` writes the updated applied-versions list back to `_meta`.

The `_meta` collection is a regular Skalex collection with a single document keyed `"migrations"`:

```js
{ _id: "migrations", appliedVersions: [1, 2, 3] }
```

Duplicate version registration throws immediately. Version numbers must be positive integers.

---

## 13. Transaction Mechanism

`db.transaction(fn)` provides snapshot-based rollback:

1. **Snapshot** — deep-copy `data[]` and shallow-copy `index` Map for every collection currently in memory.
2. **Execute** — call `fn(db)`. The callback receives the same `db` instance; all operations mutate in place.
3. **Commit** — if `fn` resolves, call `saveData()`.
4. **Rollback** — if `fn` throws, restore `data` and `index` from snapshot and rebuild `fieldIndex` via `buildFromData()`. Re-throw the error.

**Limitation**: the snapshot is taken at call time. Collections created inside `fn` are not rolled back. This is acceptable for Phase 1 — WAL-based durability is a Phase 2+ concern.

---

## 14. Auto-Connect

`_ensureConnected()` is called at the top of every public operation. On the first call:

```js
this._autoConnectPromise = this.connect();
return this._autoConnectPromise;
```

Subsequent concurrent calls before `connect()` resolves await the same promise — no double-connect race. After `connect()` resolves, `isConnected = true` and the guard short-circuits immediately.

---

## 15. Namespace

`db.namespace(id)` returns a new `Skalex` instance with `path` set to `{parent.dataDirectory}/{id}`. All other config (`format`, `debug`) is inherited.

The namespaced instance is fully independent — separate collections map, separate adapter instance pointing at the subdirectory. Cross-namespace access requires explicit construction of a second instance.

---

## 16. Build Pipeline

Tool: **Rollup** with `@rollup/plugin-node-resolve`, `@rollup/plugin-commonjs`, `@rollup/plugin-terser`.

Config file: `rollup.config.mjs` (`.mjs` extension so Node treats it as ESM without requiring `"type": "module"` in `package.json`, which would break the CJS source files).

Four outputs:

| File | Format | Minified |
|---|---|---|
| `dist/skalex.esm.js` | ESM | No |
| `dist/skalex.esm.min.js` | ESM | Yes |
| `dist/skalex.cjs.js` | CJS | No |
| `dist/skalex.cjs.min.js` | CJS | Yes |

All four include source maps. Node built-ins (`fs`, `path`, `zlib`, `crypto`, `os`) are marked `external` — they are never bundled.

The `./min` subpath export in `package.json` points to the minified pair:

```json
"./min": {
  "import": "./dist/skalex.esm.min.js",
  "require": "./dist/skalex.cjs.min.js",
  "types": "./dist/skalex.d.ts"
}
```

TypeScript declarations are hand-written in `src/index.d.ts` and copied to `dist/skalex.d.ts` as part of the `build` script. Auto-generation was considered and rejected — the JS source cannot produce generics-quality types for `Collection<T>`, `Filter<T>`, or `DocOf<T>` without significant JSDoc overhead that would add noise without the type-safety payoff of a TypeScript source.

---

## 17. Test Strategy

Runner: **Vitest** (kept over Bun test because `LocalStorageAdapter` tests require a jsdom/browser environment, which Bun test does not support as of v1.x).

### MemoryAdapter (`tests/helpers/MemoryAdapter.js`)

In-memory `StorageAdapter` for CI — no disk I/O, no temp files. Implements:

- `read / write / delete / list` — backed by `Map<name, string>`
- `join / ensureDir / writeRaw / readRaw` — stubs for `Collection.export` and `Skalex.import`
- `getRaw(filePath)` — test assertion helper to inspect written export content

All integration tests inject a `MemoryAdapter` instance. No test touches the real file system.

### Test files

| File | Coverage |
|---|---|
| `tests/unit/query.test.js` | `matchesFilter`, `presortFilter` — all operators, edge cases |
| `tests/unit/indexes.test.js` | `IndexEngine` — add/remove/update/lookup/unique constraint |
| `tests/unit/validator.test.js` | `parseSchema`, `validateDoc`, `inferSchema` |
| `tests/unit/ttl.test.js` | `parseTtl`, `computeExpiry`, `sweep` |
| `tests/unit/migrations.test.js` | `MigrationEngine` — registration, ordering, run, status |
| `tests/integration/skalex.test.js` | Full CRUD, schema, TTL, migrations, transactions, upsert, seed, dump, inspect, import/export, namespace |

---

## 18. Phase 0 Bug Fixes

The following critical bugs from v3.2.5 were fixed before any v4 feature work:

| # | Bug | Fix |
|---|---|---|
| 1 | `findOne()` returned raw `item` instead of projected `newItem` — populate and select silently discarded | Return `newItem` |
| 2 | `matchesFilter()` short-circuited on first key — multi-condition AND filters broken | Loop all keys, return `false` on first mismatch, `true` only after all pass |
| 3 | `applyUpdate()` modified a local copy of `item[field]` for `$inc`/`$push` but never wrote back | Operate directly on `item[field]` |
| 4 | `isSaving` was a single database-level flag — concurrent saves to different collections blocked each other | Per-collection `isSaving` flag on the store object |
| 5 | Inconsistent return shapes — `insertOne`/`updateOne`/`deleteOne` returned raw doc; others used wrappers | Standardised to `{ data }` / `{ docs }` across all methods |
| 6 | `export()` imported Node's native `fs` directly — broke browser/edge adapter compatibility | Routed through `this.database.fs.writeRaw()` |
| 7 | `Object.assign(item, item)` dead no-op line in `applyUpdate()` | Removed |
| 8 | `index.d.ts` referenced renamed/removed APIs, missing options, wrong constructor signature | Full rewrite from scratch |
| 9 | `matchesFilter` function-filter check fired after empty-filter guard — functions (zero enumerable keys) matched the empty-filter branch and always returned `true` | Moved function check before empty-filter check |
| 10 | Sort comparator returned wrong direction — `if (a < b) return sortValue` sorted descending when `sortValue = 1` | Changed to `if (a < b) return -dir; if (a > b) return dir` |

---

## 19. Embedding Adapter Interface

File: `src/adapters/embedding/base.js`

Single-method interface:

```js
class EmbeddingAdapter {
  async embed(text) → number[]
}
```

`embed()` receives a plain string and returns a numeric array. Dimensionality is model-dependent (OpenAI `text-embedding-3-small` = 1536, Ollama `nomic-embed-text` = 768). Skalex itself is dimension-agnostic — `cosineSimilarity` works on any length, but all documents in a collection must use the same model to produce comparable vectors.

### Configuration

The adapter is wired via the `ai` constructor option:

```js
new Skalex({ ai: { provider: "openai", apiKey, model } })
```

`_createEmbeddingAdapter({ provider, apiKey, model, host })` in `index.js` switches on `provider` and instantiates the correct subclass. Both built-in adapters use native `fetch` (Node ≥18, Bun, Deno, browser — no extra dependency).

`this._aiConfig` stores the raw config object so `namespace()` can pass it to child instances, giving all namespaces the same embedding adapter without re-instantiation.

### Writing a custom adapter

```js
class MyAdapter extends EmbeddingAdapter {
  async embed(text) {
    // call any API or run a local model
    return Float32Array.from(rawVector); // or a plain number[]
  }
}

const db = new Skalex({ path: "./data" });
db._embeddingAdapter = new MyAdapter();
```

---

## 20. Vector Storage & Stripping

Vectors are stored **inline** on documents as `_vector: number[]`. This means:

- No separate vector store or side-collection — one document, one file.
- Vectors serialise to JSON as regular arrays (JSON has no `Float32Array` type).
- On load, vectors remain as plain `number[]` — no reconstruction step needed.
- `_vector` is treated as a system field, parallel to `_id`, `createdAt`, `_expiresAt`.

### `stripVector(doc)` — `src/vector.js`

Every code path that returns a document to the caller passes through `stripVector`:

| Method | Where stripped |
|---|---|
| `insertOne` | Return value: `return { data: stripVector(newItem) }` |
| `insertMany` | Return value: `return { docs: newItems.map(stripVector) }` |
| `findOne` | After `Object.assign(newItem, item)`: `delete newItem._vector` |
| `find` | Same as `findOne` inside the result loop |
| `search` | `top.map(r => stripVector(r.doc))` |
| `similar` | `top.map(r => stripVector(r.doc))` |

The raw document inside `_data` always retains `_vector` for future similarity computations. `stripVector` creates a shallow copy — it does not mutate the stored document.

---

## 21. Vector Search Engine

File: `src/vector.js`, `src/collection.js`

### `cosineSimilarity(a, b)`

```
dot(a, b) / (|a| × |b|)
```

Computed in a single loop — O(d) where d = vector dimensions. Returns `0` for zero-magnitude vectors to avoid `NaN`. Throws on dimension mismatch.

### `collection.search(query, { filter, limit, minScore })`

1. `await this.database.embed(query)` — produce a query vector via the configured adapter.
2. Get candidates: `filter` present → `_findAllRaw(filter)` (structured pre-filter, leverages `IndexEngine`); no filter → `this._data`.
3. For each candidate with a `_vector`, compute `cosineSimilarity(queryVector, doc._vector)`.
4. Drop candidates below `minScore`.
5. Sort descending by score, slice to `limit`.
6. Return `{ docs: top.map(stripVector), scores: top.map(score) }`.

This is **hybrid search** when `filter` is provided — the structured filter narrows candidates before the cosine ranking step, which is both faster and more precise than post-filtering.

### `collection.similar(id, { limit, minScore })`

1. Resolve source document via `this._index.get(id)`.
2. Early-return `{ docs: [], scores: [] }` if not found or has no `_vector`.
3. Iterate `this._data`, skipping the source document itself and any doc without `_vector`.
4. Compute cosine similarity, apply `minScore` threshold.
5. Sort, slice, strip, return.

### Complexity

| Operation | Time | Notes |
|---|---|---|
| `search` (no filter) | O(n × d) | n = collection size, d = dimensions |
| `search` (with filter) | O(k × d) | k = filtered candidate count |
| `similar` | O(n × d) | Always full scan minus one doc |

For collections up to ~50K documents at 1536 dimensions, search completes in well under 100ms on modern hardware. WASM-accelerated SIMD similarity is planned for Phase 4+ as an opt-in.
