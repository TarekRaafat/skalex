# beta.1 Release Plan

**Status:** Pending alpha.4 completion
**Version:** v4.0.0-beta.1
**Prerequisite:** All alpha.4 items resolved and shipped.
**Gate:** beta.1 does not ship until every item passes regression tests and all existing tests remain green.
**Rule:** beta.1 introduces feature-level improvements deferred from alpha. Each item must be fully tested and backwards-compatible.
**Theme:** Bulk operation performance, feature backlog items deferred from alpha.

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

1. `upsertMany` uses `executeBatch()` - per-batch overhead is amortized (single connection check, single snapshot, single hook pair, single dirty mark, single save).
2. Per-document correctness is preserved (changelog, events, tx guards).
3. Changelog restore rehydrates exact archived documents - `createdAt`, `updatedAt`, `_version`, `_expiresAt` match historical state.
4. Every connector subpath has `import` / `require` / `types` entries, does not bypass build outputs.
5. All existing tests pass unchanged.
6. All regression tests exist and pass.
7. The verification matrix passes.

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

1. **#2** (changelog restore) - correctness fix, depends on alpha.4 #2
2. **#3** (connector exports) - packaging fix, no code dependency
3. **#1** (upsertMany batch pipeline) - performance, depends on alpha.4 #2
