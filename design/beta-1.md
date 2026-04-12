# beta.1 Release Plan

**Status:** Pending alpha.4 completion
**Version:** v4.0.0-beta.1
**Prerequisite:** All alpha.4 items resolved and shipped.
**Gate:** beta.1 does not ship until every item passes regression tests and all existing tests remain green.
**Rule:** beta.1 introduces feature-level improvements deferred from alpha and production-grade reliability guarantees. Each item must be fully tested and backwards-compatible.
**Theme:** Production-grade reliability (WAL, crash-safe transactions), serialization correctness, bulk operation performance.

---

## P0 - Reliability

### 4. Write-ahead log for crash-safe multi-collection transactions

**Issue:** #6, #12
**Severity:** P0 - critical
**Effort:** Large

**Problem:** `transaction()` calls `saveData()` after `fn()` resolves. `saveData()` flushes all touched collections in parallel via `Promise.all()`. Two failure modes:

1. **Process crash mid-flush (#6):** If the process crashes (OOM, SIGKILL, power loss) partway through the concurrent writes, some collections are persisted at the new state and others remain at the pre-transaction state. The database wakes up inconsistent with no detection or recovery path.

2. **Adapter error mid-flush (#12):** If any single collection write fails (disk full, adapter error, I/O timeout), already-written collections are not reverted. The `Promise.all` rejects but the partial commit is permanent.

Alpha.3 narrowed the window (sequential `_meta` ordering, flush sentinel detection on next `connect()`), but the fundamental issue remains: there is no atomicity guarantee across multiple collection files.

**Fix:** Implement a write-ahead log (WAL):

1. Before flushing any collection, write a single `_wal` entry describing the intended commit: which collections will be written and a checksum or version for each.
2. Flush all collections (parallel or sequential).
3. After all collections are successfully written, delete the `_wal` entry.
4. On `connect()`, if a `_wal` entry exists, the previous commit was interrupted. Depending on what was written:
   - If no collections were flushed: discard the WAL (clean rollback).
   - If some collections were flushed: either replay the remaining writes from pre-commit snapshots embedded in the WAL, or revert the written collections to the pre-transaction state.

**Design considerations:**
- The WAL must work across all adapter tiers. `FsAdapter` writes a `_wal.json` file. `BunSQLiteAdapter` / `LibSQLAdapter` can use a WAL table. `D1Adapter` needs a WAL row. `MemoryAdapter` and `BrowserAdapter` may skip WAL (no crash recovery needed for in-memory or localStorage).
- WAL size: embedding full pre-commit snapshots makes the WAL large but recovery simple. Embedding only deltas is smaller but recovery is complex. Start with full snapshots; optimize later if WAL size is a problem.
- The WAL is an adapter capability tier (alpha.4 #15). Adapters that don't support WAL should document the limitation.
- Performance: WAL adds one extra write per transaction. For most workloads this is negligible. For high-frequency micro-transactions, the overhead must be measured and documented.

**Scope:**
- New `src/engine/wal.js` module (or integrated into `persistence.js`)
- `src/engine/persistence.js` - commit path writes WAL before flush, deletes after
- `src/index.js` - `connect()` checks for incomplete WAL on startup
- Adapter interface: `writeWal(entry)`, `readWal()`, `deleteWal()` methods
- `src/connectors/storage/fs.js`, `encrypted.js`, `d1.js`, `sqlite.js` - WAL methods
- `src/index.d.ts` - WAL-related adapter interface
- `docs/documentation.md` - transaction durability guarantees
- `CHANGELOG.md`, `MIGRATION.md`

**Tests:**
1. Normal transaction: WAL written before flush, deleted after. No WAL present after successful commit.
2. Simulated crash mid-flush (fail adapter write for one collection): WAL survives, next `connect()` detects incomplete commit, recovers to consistent state.
3. All collections failed to flush: WAL present, next `connect()` rolls back cleanly.
4. WAL recovery: inject a WAL entry with known state, call `connect()`, assert database is in the pre-transaction or fully-committed state (not mixed).
5. Adapter without WAL support: transaction still works, degraded durability is logged as warning on first transaction.
6. Performance: measure transaction overhead with WAL vs without on 1000-doc batch.

**Depends on:** alpha.4 #15 (adapter capability tiers), alpha.4 #17 (DataStore abstraction)

---

### 5. Out-of-band type metadata to eliminate `__skalex_bigint__` key collision

**Issue:** #19
**Severity:** P1 - correctness
**Effort:** Medium

**Problem:** The BigInt-safe serializer encodes BigInt values as tagged objects embedded directly in the data: `{ __skalex_bigint__: "9007199254740993" }`. Any document that legitimately stores an object with a `__skalex_bigint__` key is incorrectly revived as a BigInt on load. This is a silent data corruption vector.

**Fix:** Move type metadata out of the data and into a parallel structure, similar to the approach used by superjson and devalue:

```json
{
  "data": { "n": "9007199254740993" },
  "meta": { "types": { "n": "bigint" } }
}
```

The serializer writes both `data` and `meta` on save. The deserializer checks for `meta.types` on load and reconstructs typed values without polluting the document shape. If `meta` is absent (pre-beta.1 data), fall back to the current `__skalex_bigint__` tag detection for backwards compatibility.

**Steps:**
1. Refactor the serializer/deserializer to emit and consume the parallel `meta.types` structure.
2. Maintain backwards-compatible read path for existing `__skalex_bigint__` tags.
3. On re-save, old-format documents automatically migrate to the new format (tag is removed, `meta.types` is written).
4. Extend the approach to `Date` values (currently tagged as `__skalex_date__`) for consistency.
5. Update `.d.ts` if the serializer is part of the public surface.
6. Document the format change in CHANGELOG and MIGRATION.

**Tests:**
1. Round-trip: BigInt value saves and loads correctly in new format.
2. Round-trip: Date value saves and loads correctly in new format.
3. Backwards compat: old-format `__skalex_bigint__` tag loads correctly.
4. Auto-migration: old-format document re-saved uses new format.
5. Collision: document with a literal `__skalex_bigint__` key is NOT revived as BigInt.
6. Nested BigInt/Date values at arbitrary depth are handled.

**Depends on:** None. Can ship independently.

---

## P1 - Performance Optimization

### 1. Batch pipeline for `upsertMany`

**Issue:** None
**Severity:** P1 - high
**Effort:** Medium

**Problem:** `upsertMany()` ([collection.js:409-420](../src/engine/collection.js#L409))
loops with `for...of`, calling `this.upsert()` per document. Each call goes
through `MutationPipeline.execute()` ([pipeline.js:39-118](../src/engine/pipeline.js#L39)),
which repeats per document:

1. `ctx.ensureConnected()` - connection check
2. `_txSnapshotIfNeeded()` - transaction snapshot
3. `assertTxAlive()` - stale tx guard
4. Plugin `beforeHook` execution
5. The actual mutation
6. `markDirty()` - persistence tracking
7. `_saveIfNeeded()` - per-call save (deferred via `save: false`, but still called)
8. Changelog iteration (per-document if enabled)
9. Session stats recording
10. Event emission (per-document)
11. Plugin `afterHook` execution

The only current optimization is passing `save: false` to defer the final
persist to the end of the loop.

**Fix:** Add a dedicated `executeBatch()` method to `MutationPipeline` that
amortizes per-batch overhead while keeping per-document correctness:

**Amortize once per batch:**
- `ensureConnected()` - single check at batch start
- `_txSnapshotIfNeeded()` - single snapshot at batch start
- `assertTxAlive()` - single eager check at batch start, plus a guard
  callable for the mutate phase (same as today)
- Plugin `beforeHook` - single call with the full batch payload
- `markDirty()` - single call after all mutations
- `_saveIfNeeded()` - single call at batch end
- Session stats - single `recordWrite()` call (or single deferred call for tx writes)
- Plugin `afterHook` - single call with the full batch payload

**Keep per-document:**
- The actual mutation (insert or update per doc)
- Changelog entries (each doc needs its own log entry)
- Event emission (consumers expect per-document events)

```js
async executeBatch({ op, beforeHook, afterHook, hookPayload, mutateBatch, afterHookPayload, save, session }) {
  const ctx = this._ctx;

  await ctx.ensureConnected();
  this._col._txSnapshotIfNeeded();

  const txm = ctx.txManager;
  const isTxWrite = txm.active && this._col._activeTxId === txm.context?.id;
  const entryTxId = isTxWrite ? txm.context.id : null;
  const collTxId = this._col._createdInTxId;

  const assertTxAlive = () => { /* same guards as execute() */ };
  if (isTxWrite || collTxId !== null) assertTxAlive();

  if (beforeHook) await ctx.plugins.run(beforeHook, hookPayload);

  // mutateBatch returns { docs: object[], prevDocs: (object|null)[] }
  const { docs, prevDocs = [] } = await mutateBatch(assertTxAlive);

  ctx.persistence.markDirty(ctx.collections, this._col.name);
  await this._col._saveIfNeeded(save);

  // Changelog - per-document (required for correctness)
  if (this._col._changelogEnabled) {
    for (let i = 0; i < docs.length; i++) {
      await ctx.logChange(op, this._col.name, docs[i], prevDocs[i] ?? null, session || null);
    }
  }

  // Stats - single call
  if (!isTxWrite || !txm.defer(() => ctx.sessionStats.recordWrite(session))) {
    ctx.sessionStats.recordWrite(session);
  }

  // Events - per-document (consumers expect individual events)
  for (const doc of docs) {
    ctx.emitEvent(this._col.name, { op, collection: this._col.name, doc: stripVector(doc) });
  }

  if (afterHook) {
    await ctx.runAfterHook(afterHook, afterHookPayload(docs));
  }

  return { docs, prevDocs };
}
```

Then rewrite `upsertMany` to use it:

```js
async upsertMany(docs, matchKey, options = {}) {
  await this._ctx.ensureConnected();
  const { save, ...rest } = options;

  return this._pipeline.executeBatch({
    op: "upsert",
    beforeHook: "beforeUpsert",
    afterHook: "afterUpsert",
    hookPayload: { collection: this.name, docs },
    mutateBatch: async (assertTxAlive) => {
      const results = [];
      const prevDocs = [];
      for (const doc of docs) {
        assertTxAlive();
        const { result, prev } = await this._upsertOne(
          { [matchKey]: doc[matchKey] }, doc, rest
        );
        results.push(result);
        prevDocs.push(prev);
      }
      return { docs: results, prevDocs };
    },
    afterHookPayload: (docs) => ({ collection: this.name, docs }),
    save,
    session: options.session,
  });
}
```

**Scope:** `src/engine/pipeline.js`, `src/engine/collection.js`

**Test:**
1. Benchmark `upsertMany` with 1000 documents - assert reduced overhead vs current loop-per-upsert approach
2. Assert plugin hooks fire once per batch (not per document)
3. Assert changelog entries are created per document
4. Assert events are emitted per document
5. Assert transaction rollback correctly reverts the entire batch
6. All existing `upsertMany` tests pass unchanged

**Depends on:** alpha.4 #2 (Collection decomposition)

---

## P1 - Correctness

### 2. Fix lossy changelog point-in-time restore

**Issue:** None
**Severity:** P1 - high
**Effort:** Medium

**Problem:** Changelog restore replays through `insertOne()` / `updateOne()`
instead of rehydrating raw snapshots.

- Single-document restore ([changelog.js:94-101](../src/features/changelog.js#L94))
  strips `createdAt` / `updatedAt` (line 97-98), then calls `updateOne()`
  which sets `updatedAt = new Date()`.
- Full-collection restore ([changelog.js:122-127](../src/features/changelog.js#L122))
  calls `insertOne()` → `_buildDoc()` ([collection.js:1050-1063](../src/engine/collection.js#L1050)):
 - `createdAt` / `updatedAt` regenerated as `new Date()`
 - `_version` reset to `1`
 - `_expiresAt` recomputed from current TTL config
 - `_vector` recomputed if embedding configured

Restored documents get current timestamps, not historical state.

**Fix options:**

- **(A)** Exact restore: add `_rehydrateDoc(doc)` to `DocumentBuilder`
  (alpha.4 #2) that writes the archived document directly, preserving all
  system fields. Bypass the mutation pipeline.

- **(B)** Best-effort replay: keep current approach, document as lossy,
  rename from "restore" to "replay" in README.

Option A - the feature is positioned as time-travel recovery. If it can't
faithfully restore state, it's misleading.

**Scope:** `src/features/changelog.js`, `src/engine/document-builder.js` (after alpha.4 #2)

**Test:**
1. Insert a document, note `createdAt`, `updatedAt`, `_version`
2. Update 3 times (advancing `_version` to 4)
3. Restore to state after first update
4. Assert `createdAt` matches original insert timestamp exactly
5. Assert `updatedAt` matches first-update timestamp exactly
6. Assert `_version` is 2 (not 1 or 5)
7. If TTL configured, assert `_expiresAt` matches archived value
8. Full-collection restore: delete all, restore, assert all timestamps/versions match archived values

**Depends on:** alpha.4 #2 (DocumentBuilder extraction)

---

## P2 - Package Distribution

### 3. Normalize connector subpath exports

**Issue:** None
**Severity:** P2 - medium
**Effort:** Small

**Problem:** Root entrypoint ([package.json:52-63](../package.json#L52)) has
`import` / `require` / `browser` / `types`. Connector subpaths
([package.json:65-94](../package.json#L65)) only define `import` pointing
directly into `src/`. No CJS, no types for connectors. Different runtime
semantics between `skalex` (built) and `skalex/connectors/*` (raw source).

**Fix:** Add `require`, `types` (and optionally `browser`) entries for each
connector subpath. Requires build pipeline to emit per-connector bundles.
If too heavy, at minimum add `types` entries pointing to `.d.ts` files in `src/`.

```json
"./connectors/storage/fs": {
  "import": "./dist/connectors/storage/fs.esm.js",
  "require": "./dist/connectors/storage/fs.cjs",
  "types": "./dist/connectors/storage/fs.d.ts"
}
```

**Scope:** `package.json`, build config (rollup/esbuild), optionally
`src/connectors/**/index.d.ts`

**Test:**
1. `require("skalex/connectors/storage/fs")` resolves in Node CJS
2. `import` resolves in ESM
3. TypeScript `import` of each connector subpath resolves types
4. `npm run types:check` passes with consumer-side connector imports

**Depends on:** None

---

## Regression Test Requirements

| Fix | Test scenario |
|-----|---------------|
| #1 (upsertMany batch) | 1000-doc upsert - hooks fire once, changelog per-doc, events per-doc, tx rollback reverts all |
| #2 (changelog restore) | Restore preserves exact `createdAt`, `updatedAt`, `_version`, `_expiresAt` from archived state |
| #3 (connector exports) | `require()` and `import` resolve for each connector subpath; `types:check` passes for consumer imports |
| #4 (WAL) | WAL written before flush, deleted after; simulated crash mid-flush recovers to consistent state; adapter without WAL degrades gracefully |
| #5 (BigInt out-of-band) | Round-trip BigInt/Date; backwards compat; auto-migration; literal `__skalex_bigint__` key not misinterpreted |

---

## Verification Matrix

beta.1 is not done when only the new tests pass. The release must also verify:

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

beta.1 is done when:

1. Multi-collection transactions are crash-safe via WAL. A simulated crash mid-flush recovers to a consistent pre-transaction or fully-committed state on next `connect()`.
2. BigInt/Date serialization uses out-of-band `meta.types` structure. Old-format data auto-migrates. Documents with literal `__skalex_bigint__` keys are not misinterpreted.
3. `upsertMany` uses `executeBatch()` - per-batch overhead is amortized (single connection check, single snapshot, single hook pair, single dirty mark, single save).
4. Per-document correctness is preserved (changelog, events, tx guards).
5. Changelog restore rehydrates exact archived documents - `createdAt`, `updatedAt`, `_version`, `_expiresAt` match historical state.
6. Every connector subpath has `import` / `require` / `types` entries, does not bypass build outputs.
7. All existing tests pass unchanged.
8. All regression tests exist and pass.
9. The verification matrix passes.

---

## Out of Scope for beta.1

| Item | Tracking |
|---|---|
| Changelog retention / compaction | beta |
| ANN vector indexing | beta |
| `namespace()` capability checks | beta |
| Transaction proxy hardening | beta |
| `dropCollection()` | beta feature backlog |
| `$exists`, `$set`, `$unset` operators | beta feature backlog |
| Cursor / iterator API for `find()` | beta feature backlog |
| Bulk delete by ID array | beta feature backlog |

---

## Execution Order

1. **#4** (WAL) - crash-safe transactions, depends on alpha.4 #15 + #17
2. **#5** (BigInt out-of-band) - serialization correctness, no code dependency
3. **#2** (changelog restore) - correctness fix, depends on alpha.4 #2
4. **#3** (connector exports) - packaging fix, no code dependency
5. **#1** (upsertMany batch pipeline) - performance, depends on alpha.4 #2
