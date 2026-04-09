# alpha.4 Release Plan

**Status:** Pending alpha.3 completion
**Version:** v4.0.0-alpha.4
**Prerequisite:** All alpha.3 items resolved and shipped.
**Gate:** alpha.4 does not ship until every item passes regression tests and all existing tests remain green.
**Rule:** alpha.4 reshapes module boundaries for long-term maintainability. Each extraction must be behavior-preserving - no new features bundled with refactors.
**Theme:** Break apart god objects, optimize hot paths, prepare the architecture for GA.

---

## P0 - Architecture Decomposition

### 1. Decompose `Skalex` god object

**Issue:** None
**Severity:** P0 - critical
**Effort:** Large

**Problem:** `src/index.js` is 792 lines coordinating lifecycle, storage,
migrations, namespaces, transactions, plugins, events, query cache, changelog,
memory, AI, MCP, import/export, TTL, stats, and schema introspection. While
most methods are thin delegations, the class is the central coupling hub for
every subsystem.

**Extraction targets (in order of isolation):**

1. **`SkalexAI`** - `ask()`, `embed()`, `schema()`, `_queryCache`,
   `_aiAdapter`, `_embeddingAdapter`, and the `_saveMeta(queryCache)` call.
   Self-contained: only dependency is the query cache persistence path
   (handled via `PersistenceManager.updateMeta()` after alpha.3 #8).

2. **`TtlScheduler`** - `_sweepTtl()`, `_ttlTimer`, `_ttlSweepInterval`,
   and the `setInterval`/`clearInterval` lifecycle. Pure scheduling logic
   with no cross-cutting dependencies.

3. **`SkalexImporter`** - `import()` method. Currently the only place on
   `Skalex` that calls `this.fs.readRaw()`. Small but removes a
   filesystem-specific concern from the main class.

After extraction, `Skalex` becomes a facade that composes:
`CollectionRegistry`, `PersistenceManager`, `TransactionManager`,
`MigrationEngine`, `SkalexAI`, `TtlScheduler`, `ChangeLog`, `EventBus`,
`PluginEngine`, `SessionStats`, `QueryLog`.

**Outcome:** `Skalex` class drops to ~400 lines of pure composition and
lifecycle orchestration.

**Additional fix (type drift):** While reshaping the constructor surface,
align `SkalexConfig` in `src/index.d.ts` with runtime:
- Add `lenientLoad?: boolean` to `SkalexConfig` (accepted at
  [index.js:99](../src/index.js#L99), passed to PersistenceManager at
  [index.js:152](../src/index.js#L152), missing from the type).
- Widen logger level from `'info' | 'error'` to `'info' | 'warn' | 'error'`
  (runtime emits `'warn'` at [collection.js:330](../src/engine/collection.js#L330)
  and [collection.js:906](../src/engine/collection.js#L906)).

**Scope:** `src/index.js`, `src/index.d.ts`, new `src/engine/ai.js`, `src/engine/ttl.js`, `src/engine/importer.js`

**Test:** All existing integration tests must pass unchanged. The extracted
classes should have focused unit tests. `types:check` must pass with the
updated `SkalexConfig` definition.

**Depends on:** alpha.3 #8 (consolidate `_getMeta`/`_saveMeta`), alpha.3 #9 (shared context)

---

### 2. Decompose `Collection` god object

**Issue:** None
**Severity:** P0 - critical
**Effort:** Large

**Problem:** `src/engine/collection.js` is ~1,050 lines owning CRUD,
validation, index coordination, query planning, projection, population,
aggregation, vector search, watch iterators, file export, cap enforcement,
and document construction. The `MutationPipeline` extraction reduced CRUD
boilerplate, but the class still has too many concerns.

**Extraction targets (in order of isolation):**

1. **`CollectionExporter`** (~50 lines) - `export()` method with CSV/JSON
   formatting. Only place that depends on `_ctx.fs` for raw writes. Clean
   extraction with zero cross-dependencies.

2. **`VectorSearch`** (~65 lines) - `search()` and `similar()`. Self-contained
   cosine-similarity scoring with its own sorting/slicing logic. Only
   dependency is `_ctx.embed()` and `_ctx.plugins`.

3. **`DocumentBuilder`** (~30 lines) - `_buildDoc()` with ID generation,
   timestamps, TTL computation, embedding, and versioning. Consolidates all
   document construction rules.

4. **`QueryPlanner`** (~100 lines) - `_findRaw()`, `_findAllRaw()`,
   `_getCandidates()`, `_findIndex()`. Encapsulates index-aware candidate
   selection. Depends on `_fieldIndex` and `matchesFilter()`.

After extraction, `Collection` retains: CRUD orchestration (via pipeline),
`watch()`, aggregation helpers (delegating to pure functions), and the
private index/validation helpers that bridge to extracted modules.

**Outcome:** `Collection` class drops to ~500 lines of orchestration.

**Scope:** `src/engine/collection.js`, new `src/engine/exporter.js`, `src/engine/vector.js`, `src/engine/document-builder.js`, `src/engine/query-planner.js`

**Test:** All existing collection tests must pass unchanged. Extracted modules
get focused unit tests.

**Depends on:** alpha.3 #10 (remove `Collection.database`), alpha.3 #11 (soft-delete guard)

---

### 3. Add backpressure to watch event queues

**Issue:** None
**Severity:** P0 - critical
**Effort:** Medium

**Problem:** The `_watchIterator` in `collection.js:443-471` pushes events
into an unbounded `queue` array. A slow async consumer with a fast producer
will cause unbounded memory growth.

**Fix:** Add a `maxBufferSize` option (default: 1000) to the watch iterator.
When the buffer is full, either:
- **(A)** Drop oldest events (lossy but non-blocking), or
- **(B)** Apply backpressure by pausing event delivery until the consumer
  catches up (lossless but can block the event bus).

**API design decision:** Option A is simpler and matches the behavior of
most real-time event systems. Option B requires cooperative scheduling.
Recommend Option A with a `dropped` counter on the iterator for observability.

**Scope:** `src/engine/collection.js`

**Test:** Create a watch iterator, emit 2000 events without consuming. Assert
buffer stays at `maxBufferSize` and oldest events are dropped.

**Depends on:** None

---

### 16. Tighten transaction isolation for out-of-band writes

**Issue:** None
**Severity:** P0 - critical
**Effort:** Medium

**Problem:** `snapshotIfNeeded()` deep-clones `col.data` via `structuredClone`
([index.js:790](../src/index.js#L790)) before the first transactional write.
Rollback restores the snapshot by replacing the live array: `col.data = snap.data`
([index.js:801](../src/index.js#L801)). Non-transactional writes mutate the
same `col.data` in memory. If a non-tx write hits a collection already
snapshotted by a transaction, rollback overwrites that non-tx write - the
entire array is replaced with the pre-snapshot copy.

Existing test ([data-integrity.test.js:170](../tests/integration/data-integrity.test.js#L170))
only proves survival for writes to a different, untouched collection. No test
covers the unsafe case: non-tx write to a tx-touched collection followed by
rollback.

**Fix options:**

- **(A)** Block non-tx writes while a transaction touches a collection.
  Reject with `TransactionError("ERR_SKALEX_TX_COLLECTION_LOCKED", ...)`
  until commit or rollback.

- **(B)** Per-collection copy-on-write. Transactional writes operate on a
  cloned copy; commit merges back; rollback discards. Non-tx writes always
  hit the live state.

Option A for alpha.4 - simpler, matches the existing single-writer model
(`_txLock` serializes transactions). Option B can follow in beta if needed.

**Scope:** `src/engine/transaction.js`, `src/engine/collection.js`, `src/engine/pipeline.js`

**Test:**
1. Start a transaction that writes to collection "items"
2. Outside the transaction, attempt `insertOne()` on "items"
3. Assert the outside write is rejected with `ERR_SKALEX_TX_COLLECTION_LOCKED`
4. Commit the transaction
5. Retry the outside write - assert it succeeds
6. Repeat with rollback instead of commit - assert outside write succeeds after rollback
7. Assert writes to a different collection during the transaction still succeed (no over-locking)

**Depends on:** alpha.4 #1 (Skalex decomposition extracts TransactionManager)

---

## P1 - Performance Optimization

### 4. Optimize `find()` pagination to avoid full materialization

**Issue:** None
**Severity:** P1 - high
**Effort:** Large

**Problem:** `find()` collects all matching documents, sorts them, then slices
for the requested page. For a collection with 100k documents where only 10
results are needed, this scans and sorts everything.

**Approach (incremental):**

1. **Limit-only fast path (no sort, no page offset):** Stop scanning after
   `limit` matches. This is the common case for `find({}, { limit: 10 })`.

2. **Sorted pagination (future):** Maintain a partial heap of size `limit`
   during scan, avoiding full sort. Or implement cursor-based pagination
   that remembers the last seen sort key.

alpha.4 should implement step 1. Step 2 is pre-GA scope.

**Scope:** `src/engine/collection.js`

**Test:** Benchmark `find({}, { limit: 10 })` on a 100k-document collection.
Assert it completes in O(n) time with early termination, not O(n log n).

**Depends on:** None

---

### 5. Skip `structuredClone` for `prev` when changelog is disabled

**Issue:** None
**Severity:** P1 - high
**Effort:** Small

**Problem:** `_prepareUpdatedDoc()` calls `structuredClone` twice per document
(lines 267-268): once for `prev`, once for `next`. The `prev` clone is only
used by the changelog. When changelog is disabled, this clone is wasted.

The caller (`_updateCore` line 187) already checks `_changelogEnabled` for
the `prevDocs` array, but `_prepareUpdatedDoc` unconditionally clones both.

**Fix:** Pass a `needsPrev` flag to `_prepareUpdatedDoc`:

```js
_prepareUpdatedDoc(currentDoc, update, { needsPrev = false } = {}) {
  const prev = needsPrev ? structuredClone(currentDoc) : null;
  const next = structuredClone(currentDoc);
  this.applyUpdate(next, update);
  // ...validation...
  return { next, prev };
}
```

**Scope:** `src/engine/pipeline.js`

**Test:** Benchmark `updateMany` on 10k documents with changelog off. Assert
~50% reduction in clone overhead.

**Depends on:** None

---

### 6. Optimize `stats()` to avoid full serialization

**Issue:** None
**Severity:** P1 - high
**Effort:** Medium

**Problem:** `registry.js:200` calls `JSON.stringify(doc)` on every document
in every collection to estimate size. For a large database this is extremely
expensive and blocks the event loop.

**Approaches:**

- **(A)** Maintain a running `_estimatedSize` counter per collection, updated
  on insert (+), delete (-), and update (delta). Cheap but approximate -
  doesn't account for nested object changes accurately.

- **(B)** Cache the computed size with a dirty flag. Recompute only when the
  collection has been mutated since last `stats()` call.

- **(C)** Sample-based estimation: serialize a random sample of documents and
  extrapolate. Fast and statistically accurate for large collections.

**Recommendation:** Option B for alpha.4. It is exact, simple, and avoids
redundant computation. Option A can replace it later if the recomputation
cost is still too high for very large collections.

**Scope:** `src/engine/registry.js`

**Test:** Call `stats()` twice without mutations. Assert the second call
does not re-serialize.

**Depends on:** None

---

## P2 - Browser & Runtime Ergonomics

### 7. Lazy-import `FsAdapter` for browser compatibility

**Issue:** None
**Severity:** P2 - medium
**Effort:** Medium

**Problem:** `src/index.js:3` statically imports `FsAdapter`. In browser
environments, this import chain pulls in `node:fs`, `node:path`, `node:zlib`.
Rollup stubs these for browser builds, but `new Skalex()` without an adapter
still instantiates `FsAdapter` with stubbed modules, producing cryptic errors
(e.g., `undefined is not a function` on `nodePath.resolve`).

**Fix options:**

- **(A)** Lazy-import `FsAdapter` only when no custom adapter is provided:
  ```js
  if (!adapter) {
    const { default: FsAdapter } = await import("./connectors/storage/fs.js");
    fs = new FsAdapter({ dir: path, format });
  }
  ```
  This makes the constructor async-dependent, which is already handled by
  `_ensureConnected()` / `connect()`.

- **(B)** Detect browser environment and throw a clear error:
  ```js
  if (!adapter && typeof window !== "undefined") {
    throw new AdapterError("ERR_SKALEX_ADAPTER_REQUIRED",
      "Browser usage requires an explicit adapter (LocalStorageAdapter or custom).");
  }
  ```

**Recommendation:** Option B for alpha.4. It is simpler, requires no async
changes, and gives consumers a clear error message. Option A can follow in
a future release if auto-detection is desired.

**Scope:** `src/index.js`

**Test:**
1. Create `new Skalex()` in a browser environment (or mock `typeof window !== "undefined"`) without providing an adapter
2. Assert it throws `AdapterError` with code `ERR_SKALEX_ADAPTER_REQUIRED`
3. Create `new Skalex({ adapter: customAdapter })` in the same environment
4. Assert it does not throw and connects successfully

**Depends on:** None

---

### 8. Complete Skalex↔Collection decoupling

**Issue:** None
**Severity:** P2 - medium
**Effort:** Small

**Problem:** After alpha.3 #10 removes `Collection.database`, the remaining
coupling is that `Collection` is constructed with a direct reference to the
`Skalex` instance (via the registry). The `_ctx` bridge object mediates all
access, but the constructor still receives the full `db` object.

**Fix:** Change the `Collection` constructor to accept `_ctx` directly
instead of the `Skalex` instance. The registry builds the context and passes
it through. `Collection` never sees `Skalex`.

**Scope:** `src/engine/collection.js`, `src/engine/registry.js`

**Test:** Assert `Collection` constructor does not accept or store a
`Skalex` reference. Existing tests pass unchanged.

**Depends on:** alpha.3 #10 (remove `Collection.database`), alpha.4 #2 (Collection decomposition)

---

## P2.5 - Modern JS Ergonomics

### 9. Add `Symbol.toStringTag` to core classes

**Issue:** None
**Severity:** P2.5 - low
**Effort:** Trivial

**Problem:** `console.log(db)` outputs `Skalex {}` or `[Object object]`
depending on the runtime. Core classes lack `Symbol.toStringTag`.

**Fix:** Add to `Skalex`, `Collection`, `TransactionManager`,
`PersistenceManager`, `IndexEngine`:

```js
get [Symbol.toStringTag]() { return "Skalex"; }
```

**Scope:** `src/index.js`, `src/engine/collection.js`, `src/engine/transactions.js`, `src/engine/persistence.js`, `src/engine/indexing.js`

**Test:**
1. Call `Object.prototype.toString.call(db)` on a `Skalex` instance
2. Assert it returns `[object Skalex]`
3. Repeat for `Collection`, `TransactionManager`, `PersistenceManager`, `IndexEngine`
4. Assert each returns the correct tag

**Depends on:** None

---

### 10. Implement `Symbol.asyncDispose` for `using` keyword

**Issue:** None
**Severity:** P2.5 - low
**Effort:** Trivial

**Problem:** ES2024 explicit resource management (`using` keyword) would
benefit Skalex connections but is not supported.

**Fix:**

```js
async [Symbol.asyncDispose]() {
  await this.disconnect();
}
```

Enables:
```js
await using db = new Skalex({ path: "./.db" });
await db.connect();
// auto-disconnect on scope exit
```

**Scope:** `src/index.js`

**Test:**
1. Create a `Skalex` instance and connect it
2. Use `await using` syntax (or manually call `Symbol.asyncDispose`)
3. Assert that `db.disconnect()` was called on scope exit
4. Assert subsequent operations throw a disconnected error

**Depends on:** None

---

### 11. Document `presortFilter` key-order reliance

**Issue:** None
**Severity:** P2.5 - low
**Effort:** Trivial (comment-only)

**Problem:** `presortFilter()` in `query.js:91-128` relies on JavaScript
object insertion-order iteration to prioritize filter key evaluation. This
is guaranteed by the ES spec for non-integer keys, but is a subtle contract.

**Fix:** Add a JSDoc comment:

```js
/**
 * ...existing docs...
 *
 * Implementation note: relies on ES2015+ object property insertion-order
 * iteration guarantee (non-integer string keys iterate in creation order).
 * This is specified in ECMA-262 §13.7.5.15 and supported by all target
 * runtimes (Node ≥18, modern browsers, Bun, Deno).
 */
```

**Scope:** `src/engine/query.js`

**Test:**
1. Verify the JSDoc comment exists on `presortFilter()` in `query.js`
2. Assert the comment mentions ES2015+ insertion-order guarantee

**Depends on:** None

---

## P3 - Adapter & Code Quality

### 12. Extract shared `fetchWithRetry()` utility from AI adapters

**Issue:** None
**Severity:** P3 - housekeeping
**Effort:** Medium

**Problem:** All 6 AI adapters (OpenAI/Ollama/Anthropic × embedding/LLM)
independently implement the same retry/timeout/exponential-backoff logic.
Each has its own `fetch` wrapper with retry count, delay doubling, timeout
via `AbortController`, and error classification.

**Fix:** Extract a shared `fetchWithRetry(url, options, { retries, retryDelay, timeout })` utility into `src/connectors/shared/fetch.js`. Each adapter
calls it instead of implementing its own retry loop.

**Scope:** `src/connectors/ai/`, new `src/connectors/shared/fetch.js`

**Test:** Unit test `fetchWithRetry` with mocked fetch: verify retry count,
delay doubling, timeout abort, and error propagation. Adapter tests should
still pass unchanged.

**Depends on:** None

---

### 13. Convert `FsAdapter` from sync to async zlib

**Issue:** None
**Severity:** P3 - housekeeping
**Effort:** Medium

**Problem:** `FsAdapter` uses `zlib.deflateSync` / `zlib.inflateSync` in
both `read()` and `write()`. For large collections, synchronous compression
blocks the event loop. The atomic persistence design doc specifies
async compression, but the implementation deviates.

**Fix:** Replace `deflateSync` → `promisify(zlib.deflate)` and
`inflateSync` → `promisify(zlib.inflate)`. Both `read()` and `write()` are
already async, so no API change needed.

**Scope:** `src/connectors/storage/fs.js`

**Test:** Benchmark read/write of a 10MB collection. Assert event loop is
not blocked (measure with `setTimeout` delay).

**Depends on:** None

---

### 14. Extract `ICollectionContext` interface for testability

**Issue:** None
**Severity:** P3 - housekeeping
**Effort:** Medium

**Problem:** `_ctx` has 15+ properties. Testing a `Collection` in isolation
requires constructing a full `Skalex` instance. There's no way to mock
individual context properties without building the entire dependency graph.

**Fix:** Define an `ICollectionContext` interface (or JSDoc typedef) that
documents the required shape. Add a `CollectionContext.forTesting(overrides)`
factory that creates a minimal context with sensible defaults and allows
callers to override specific properties.

**Scope:** `src/engine/collection.js`, new `src/engine/collection-context.js`

**Test:** Create a `Collection` using `CollectionContext.forTesting()`.
Assert basic CRUD works without a `Skalex` instance.

**Depends on:** alpha.3 #9 (shared context)

---

### 15. Formalize tiered adapter capability interfaces

**Issue:** None
**Severity:** P3 - housekeeping
**Effort:** Medium

**Problem:** Base contract in [base.js:7](../src/connectors/storage/base.js#L7)
defines `read`, `write`, `delete`, `list`, plus an optional `writeAll` fallback
([base.js:50](../src/connectors/storage/base.js#L50)). Core features rely on
methods outside this contract:

- `writeAll()` for transaction commit ([collection.js:836](../src/engine/collection.js#L836))
- `readRaw()` for import ([index.js:544](../src/index.js#L544))
- `writeRaw()` for export ([collection.js:857](../src/engine/collection.js#L857))
- `join()` / `ensureDir()` for filesystem paths ([collection.js:854-856](../src/engine/collection.js#L854))

Currently duck-typed via `typeof` checks at call sites. No way to tell from
the base class which optional methods a given adapter must implement.

**Fix:** Promote into explicit tiered interfaces:

1. **`StorageAdapter`** (base) - `read`, `write`, `delete`, `list`. Unchanged.
2. **`BatchStorageAdapter`** - extends base, adds `writeAll(entries)`.
3. **`RawFileStorageAdapter`** - extends base, adds `readRaw(path)`, `writeRaw(path, data)`.
4. **`PathAwareStorageAdapter`** - extends raw-file, adds `join(...segments)`, `ensureDir(path)`.

Replace `typeof` checks with `instanceof` assertions. The `CollectionExporter`
extraction (#2) accepts a capability-checked adapter explicitly.

**Scope:** `src/connectors/storage/base.js`, new `src/connectors/storage/batch.js`,
new `src/connectors/storage/raw-file.js`, new `src/connectors/storage/path-aware.js`,
`src/engine/collection.js`, `src/index.js`

**Test:**
1. `collection.export()` on a non-FS adapter - assert `AdapterError` with code `ERR_SKALEX_ADAPTER_NO_RAW_WRITE`
2. `collection.export()` on `FsAdapter` - assert success
3. Assert `FsAdapter instanceof PathAwareStorageAdapter` is true
4. Assert `LocalStorageAdapter instanceof PathAwareStorageAdapter` is false
5. Assert `FsAdapter instanceof BatchStorageAdapter` is true

**Depends on:** alpha.4 #2 (Collection decomposition / CollectionExporter extraction)

---

## Regression Test Requirements

Every item must ship with at least one targeted regression test:

| Fix | Test scenario |
|-----|---------------|
| #1 (Skalex decomposition) | All existing integration tests pass; extracted classes have unit tests |
| #2 (Collection decomposition) | All existing collection tests pass; extracted modules have unit tests |
| #3 (watch backpressure) | Emit 2000 events without consuming - buffer stays at maxBufferSize |
| #4 (find fast path) | `find({}, { limit: 10 })` on 100k docs - early termination verified |
| #5 (structuredClone skip) | `updateMany` with changelog off - no prev clone (benchmark) |
| #6 (stats cache) | `stats()` twice without mutations - no re-serialization |
| #7 (browser FsAdapter) | `new Skalex()` in browser without adapter - clear error message |
| #8 (decoupling) | Collection constructor accepts `_ctx` only - no Skalex ref |
| #9 (toStringTag) | `Object.prototype.toString.call(db)` returns `[object Skalex]` |
| #10 (asyncDispose) | `await using db = new Skalex(...)` disconnects on scope exit |
| #11 (presortFilter docs) | Code review check (comment-only) |
| #12 (fetchWithRetry) | Mocked fetch - retry count, delay doubling, timeout abort |
| #13 (async zlib) | Event loop not blocked during large collection read/write |
| #14 (ICollectionContext) | Collection instantiated via `forTesting()` - basic CRUD works |
| #15 (adapter tiers) | `export()` on non-FS adapter - clear `AdapterError`; `instanceof` checks pass for each tier |
| #16 (tx isolation) | Non-tx write to tx-touched collection rejected; write succeeds after commit/rollback; untouched collections unaffected |

---

## Verification Matrix

alpha.4 is not done when only the new tests pass. The release must also verify:

- `npm test`
- `npm run smoke:node`
- `npm run smoke:bun`
- `npm run smoke:deno`
- `npm run smoke:browser`
- `npm run lint`
- `npm run format:check`
- `npm run types:check`

---

## Success Criteria

alpha.4 is done when:

1. `Skalex` class is under 450 lines, composed of extracted services.
2. `Collection` class is under 550 lines, with extracted query/vector/export modules.
3. Watch iterators have bounded memory under fast-producer/slow-consumer load.
4. `find({}, { limit: 10 })` on a large collection terminates early without full sort.
5. `updateMany` with changelog disabled skips `prev` clone overhead.
6. Repeated `stats()` calls without mutations skip re-serialization.
7. `new Skalex()` in a browser without an adapter throws a clear error, not a cryptic stub failure.
8. `Collection` constructor accepts `_ctx` directly, never sees `Skalex`.
9. Core classes report meaningful names via `Symbol.toStringTag`.
10. `await using db = new Skalex(...)` works via `Symbol.asyncDispose`.
11. All existing tests pass unchanged (behavior-preserving refactors).
12. AI adapter retry logic uses a single shared `fetchWithRetry()` utility.
13. `FsAdapter` uses async zlib (no event loop blocking on large collections).
14. `Collection` can be instantiated with `CollectionContext.forTesting()` for isolated unit tests.
15. Adapter capabilities formalized into tiered interfaces (`StorageAdapter`, `BatchStorageAdapter`, `RawFileStorageAdapter`, `PathAwareStorageAdapter`).
16. Non-tx writes to a tx-touched collection are rejected; rollback cannot clobber outside writes.
17. `SkalexConfig` type exposes `lenientLoad`; logger level includes `'warn'`.
18. All regression tests exist and pass.
19. The verification matrix passes.

---

## Out of Scope for alpha.4

| Item | Tracking |
|---|---|
| Changelog retention / compaction | beta |
| Changelog restore correctness | beta.1 |
| Connector subpath export normalization | beta.1 |
| ANN vector indexing | beta |
| `namespace()` capability checks | beta |
| Transaction proxy hardening | beta |
| WAL / multi-process FsAdapter safety | long-term roadmap |
| `FsAdapter { durable: true }` (fsync) | long-term roadmap |
| `dropCollection()` | beta feature backlog |
| `$exists`, `$set`, `$unset` operators | beta feature backlog |
| Cursor / iterator API for `find()` | beta feature backlog |
| `upsertMany` batch pipeline | beta.1 |
| Bulk delete by ID array | beta feature backlog |

---

## Non-Goals

alpha.4 is not the release for:

- New user-facing features (this is a structural release)
- ANN vector indexing (beta, separate design doc)
- WAL or multi-process support (long-term roadmap)
- Changelog compaction (beta)
- Breaking API changes (all refactors are internal)

---

## Execution Order

Recommended sequence:

**Phase 1 - Decomposition (high effort, high value):**
1. **#1** (Skalex decomposition + type drift fix) - largest refactor, unlocks everything
2. **#2** (Collection decomposition) - second largest, independent of #1
3. **#8** (Skalex-Collection decoupling) - falls out of #2
4. **#16** (transaction isolation) - depends on #1, tightens tx model

**Phase 2 - Performance (medium effort):**
5. **#4** (find pagination fast path) - limit-only optimization
6. **#5** (structuredClone skip) - small, targeted
7. **#6** (stats caching) - medium, self-contained

**Phase 3 - Adapter & code quality (medium effort):**
8. **#12** (fetchWithRetry extraction) - dedup 6 adapter retry loops
9. **#13** (async zlib) - unblock event loop in FsAdapter
10. **#14** (ICollectionContext) - testability interface
11. **#15** (adapter capability tiers) - formalize tiered interfaces

**Phase 4 - Ergonomics (low effort):**
12. **#7** (browser FsAdapter error) - small, high consumer impact
13. **#3** (watch backpressure) - medium, needs API decision
14. **#9-#11** (Symbol.toStringTag, asyncDispose, presortFilter docs) - trivial batch
