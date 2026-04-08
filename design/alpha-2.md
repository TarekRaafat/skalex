# alpha.2 Release Plan

**Status:** Implemented (#1-#31), housekeeping pending (#32-#34)  
**Version:** v4.0.0-alpha.2  
**Gate:** alpha.2 does not ship until every P0, P1, and P2 item is resolved and covered by regression tests.  
**Rule:** Persistence semantics must be coherent and query/index correctness traps must be removed.  
**Theme:** Fix silent corruption bugs, close concurrency gaps, harden persistence - then ship.

---

## P0 - Silent Data Corruption Bugs

These must be fixed first. Both are user-facing, silent, and can destroy data on disk.

### 1. Fix stale Collection instances after `createCollection` → `connect`

**Issue:** [#22](https://github.com/TarekRaafat/skalex/issues/22)  
**Severity:** P0 - critical  
**Effort:** Trivial

**Problem:** `createCollection()` caches a `Collection` instance pointing to the initial
(empty) store. When `connect()` calls `loadData()`, it replaces the store in
`this.collections[name]` with a new object containing disk data - but the cached instance
still references the old empty store. `useCollection()` returns the stale instance.
Reads return zero results. Writes with `{ save: true }` overwrite disk data with the
empty store.

**Fix:** In `loadData()`, after building the new store for a collection, sync the
`_store` reference on any existing cached `Collection` instance:

```js
// After: this.collections[name] = newStore;
const cached = this._collectionInstances[name];
if (cached) cached._store = newStore;
```

**Scope:** `src/index.js` - one line in the load path.

**Test:**
1. `createCollection("users", { schema })` before `connect()`
2. Seed data to disk (or use a pre-populated adapter)
3. `connect()`
4. `useCollection("users").find({})` - assert returns loaded data, not empty
5. `useCollection("users").insertOne(doc, { save: true })` - assert does not overwrite
   pre-existing data on disk

**Depends on:** None

---

### 2. Fix upsert operator leak into inserted documents

**Issue:** [#23](https://github.com/TarekRaafat/skalex/issues/23)  
**Severity:** P0 - critical  
**Effort:** Small

**Problem:** `upsert(filter, doc)` falls through to `insertOne({ ...filter, ...doc })`
when no match is found. If the filter contains query operators (e.g.
`{ email: { $eq: "alice@example.com" } }`), those operators are stored as literal field
values. The document is silently corrupted and persists to disk.

**Fix:** Before spreading the filter into the insert payload, resolve each field to its
plain value:

```js
function resolveFilterToValues(filter) {
  const resolved = {};
  for (const [key, val] of Object.entries(filter)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const keys = Object.keys(val);
      if (keys.length === 1 && keys[0] === "$eq") {
        resolved[key] = val.$eq;
      }
      // Range operators ($gt, $in, $regex, etc.) have no single insert value - omit
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}
```

Apply in both `upsert()` and `upsertMany()`.

**Scope:** `src/engine/collection.js` - upsert insert path.

**Test:**
1. `upsert({ email: { $eq: "x" } }, { name: "A" })` on empty collection - assert
   `result.email === "x"` (string, not object)
2. `upsert({ age: { $gt: 18 } }, { name: "B" })` on empty collection - assert
   `result.age` is undefined (range operator omitted)
3. `upsert({ email: "plain" }, { name: "C" })` - assert works as before (no regression)
4. Verify round-trip: insert via upsert, `disconnect()`, `connect()`, `find()` - assert
   data is not corrupted on reload

**Depends on:** None

---

### 3. Fix `insertMany()` unique index corruption on partial batch failure

**Issue:** None  
**Severity:** P0 - critical  
**Effort:** Small

**Problem:** `_insertCore()` (`collection.js:128`) adds documents to the field index
one-by-one via `_addToIndex()`. If the second document violates a unique constraint,
the first document is already in the unique index but NOT in `_data` or `_id` index
(lines 129-130 never execute). The first document becomes a ghost entry that permanently
blocks future inserts with the same field value until reconnect.

The update path does not have this bug - it uses `_assertUniqueCandidates()` to
preflight all constraints before any mutation.

**Fix:** Preflight unique constraints for the entire insert batch before mutating any
index state. Reuse the `_assertUniqueCandidates` pattern adapted for inserts:

```js
// Before line 128, after assertTxAlive():
if (this._fieldIndex) {
  this._fieldIndex.assertUniqueBatch(newItems);
}
// Then proceed with _addToIndex loop (guaranteed safe)
```

**Scope:** `src/engine/indexes.js` - add `assertUniqueBatch()`.
`src/engine/collection.js` - call it in `_insertCore()` before the index mutation loop.

**Test:**
1. `insertMany([{email: "a"}, {email: "a"}])` with unique `email` - assert throws
   `UniqueConstraintError`, collection has 0 docs, subsequent `insertOne({email: "a"})`
   succeeds (no ghost entry)
2. `insertMany([{email: "a"}, {email: "b"}])` - assert both inserted (no regression)

**Depends on:** None

---

### 4. Fix non-transactional writes captured by active transaction

**Issue:** None  
**Severity:** P0 - critical  
**Effort:** Large

**Problem:** Transaction context is stored on the shared `TransactionManager._ctx`.
Every mutation calls `_txSnapshotIfNeeded()` which checks `txm.active` on this shared
context. The `_txLock` only serializes `transaction()` calls - regular CRUD is not
serialized. A non-transactional write that executes while a transaction is active
(e.g. during an `await` inside the transaction callback) triggers a snapshot, gets
added to `touchedCollections`, and is silently erased if the transaction rolls back.

**Fix:** Make transaction participation explicit. Recommended approach: pass a `txId`
through the mutation pipeline. Only operations whose `txId` matches the active
transaction participate in snapshot/rollback. Non-transaction operations (no `txId`)
skip `_txSnapshotIfNeeded()` entirely.

This requires:
1. The transaction proxy injects a `txId` property readable by `pipeline.execute()`
2. `_txSnapshotIfNeeded()` checks `txId` matches `txm.context?.id`, not just `txm.active`
3. Non-tx mutations bypass the snapshot path regardless of active transaction state

**Scope:** `src/engine/transaction.js`, `src/engine/pipeline.js`,
`src/engine/collection.js` - threading `txId` through the call chain.

**Test:**
1. Start transaction, `await sleep(50)` inside callback, insert outside proxy during
   sleep, rollback transaction - assert outside insert survives rollback
2. Insert inside transaction proxy, rollback - assert inside insert is rolled back
3. No-transaction insert - assert works unchanged (no regression)

**Depends on:** None

---

### 5. Fix stale transaction proxy / async continuation after timeout

**Issue:** None  
**Severity:** P0 - critical  
**Effort:** Medium

**Problem:** After a transaction completes (commit, rollback, or timeout), the proxy
remains usable. The `finally` block clears `_ctx` and `_createdInTxId`, so
`assertTxAlive()` passes (both IDs are null). The `_abortedIds` mechanism only catches
in-flight mutations - not mutations that start after cleanup. The code comment at
`transaction.js:130-131` claiming `_abortedIds` catches stale continuations is
misleading for this case.

**Fix:** Brand the proxy with the transaction's `ctx` reference. Trap all property
access and reject operations after the transaction ends:

```js
const proxy = new Proxy(db, {
  get(target, prop) {
    if (ctx !== self._ctx) {
      throw new TransactionError("ERR_SKALEX_TX_STALE_PROXY",
        `Transaction ${ctx.id} has ended. This proxy is no longer usable.`);
    }
    if (prop === "collections") throw new TransactionError(...);
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
```

**Note:** This should be implemented alongside item #4 (tx context isolation). The
combined fix ensures both external writes and stale continuations are handled.

**Scope:** `src/engine/transaction.js` - proxy handler.

**Test:**
1. Capture proxy inside `transaction()`, use after commit - assert throws
   `ERR_SKALEX_TX_STALE_PROXY`
2. Transaction with timeout, `await sleep(timeout * 2)` inside fn, then insert via
   proxy - assert throws
3. Normal transaction usage - assert proxy works during fn (no regression)

**Depends on:** alpha.2 #4

---

### 6. Fix `{ save: true }` resolving before persistence completes

**Issue:** None  
**Severity:** P0 - critical  
**Effort:** Small

**Problem:** `PersistenceManager._saveOne()` (`persistence.js:217-219`): when a save is
in-flight, the second caller sets `_pendingSave = true` and returns immediately. The
caller's `await saveData()` / `await insertOne({}, { save: true })` resolves before
their data reaches storage.

**Fix:** Accumulate waiting callers and resolve only when the pending save completes:

```js
if (col.isSaving) {
  col._pendingSave = true;
  return new Promise((resolve, reject) => {
    (col._pendingCallbacks ??= []).push({ resolve, reject });
  });
}
```

After the re-triggered save completes, resolve/reject all accumulated callbacks.

**Scope:** `src/engine/persistence.js` - `_saveOne()`.

**Test:**
1. Two concurrent `insertOne({}, { save: true })` - assert both await actual disk write
2. Mock adapter with delay - assert second caller does NOT resolve before first write
   completes + re-save runs

**Depends on:** None

---

### 7. Fix `ChangeLog.restore()` not persisting restored state

**Issue:** None  
**Severity:** P0 - critical  
**Effort:** Trivial

**Problem:** `ChangeLog.restore()` calls `deleteMany({})` and `insertOne()` without
`{ save: true }`. Restored state is only in-memory unless the caller explicitly saves
or `autoSave` is on.

**Fix:** Add `await this._db.saveData(collection)` after the restore loop:

```js
// After the restore insertOne/deleteMany loop, before returning:
await this._db.saveData(collection);
```

**Scope:** `src/features/changelog.js` - `restore()` method.

**Test:**
1. Insert docs with changelog enabled, delete some, restore to earlier timestamp,
   disconnect without explicit save, reconnect - assert restored data is present

**Depends on:** None

---

## P1 - Persistence Coherence

Original alpha-2 plan items, preserved with full constraint and option analysis.

### 8. Resolve `saveAtomic()` memory/disk divergence

**Issue:** [#6](https://github.com/TarekRaafat/skalex/issues/6) (partial)  
**Severity:** P1 - high  
**Effort:** Large

**Problem:** `saveAtomic()` in [persistence.js:149](../src/engine/persistence.js#L149) performs three sequential I/O steps: write `_meta` (sentinel), write data batch via `writeAll()`, write `_meta` again (completion). If the final `_meta` write fails, [transaction.js:110](../src/engine/transaction.js#L110) rolls back in-memory state, but the data batch is already on disk. On next `connect()`, the committed data loads as-is. Memory and disk diverge silently.

**Constraint:** The fix must not assume a specific commit protocol. "Bundle `_meta` into `writeAll()`" is not sufficient on its own - on `FsAdapter`, `writeAll()` is sequential renames, not truly atomic. The chosen approach must provide a coherent commit point regardless of the underlying adapter's atomicity guarantees.

**Approaches to evaluate:**
- **Single-batch:** include `_meta` in the `writeAll()` call so all data and metadata are part of one adapter-level operation. Works cleanly for SQLite adapters (native transaction/batch). For `FsAdapter`, this narrows the failure window but does not eliminate it.
- **Journal/manifest:** write a commit record as the final step; on load, discard any data that lacks a matching commit record. Provides adapter-agnostic crash safety at the cost of an extra read on startup.
- **Hybrid:** use the adapter's native atomicity when available (SQLite transaction, D1 batch), fall back to journal for non-atomic adapters (FsAdapter).

**Outcome:** After the fix, if `saveAtomic()` rejects, disk state must either reflect the pre-transaction state or a complete commit - never a partial one.

**Scope:** `src/engine/persistence.js` - `saveAtomic()`.

**Test:**
1. Inject adapter failure on final `_meta` write after data batch succeeds. Assert disk and memory are consistent (either both committed or both rolled back).
2. SQL adapter path: verify `_meta` is included in the `writeAll()` entries array.

**Depends on:** None

---

### 9. Resolve or narrow multi-collection `save()`/`saveDirty()` semantics

**Issue:** [#12](https://github.com/TarekRaafat/skalex/issues/12) (partial)  
**Severity:** P1 - high  
**Effort:** Medium

**Problem:** [persistence.js:122](../src/engine/persistence.js#L122) fans out to per-collection `_saveOne()` via `Promise.all`. `saveData()` and `disconnect()` use this path. If one collection write fails, others have already committed.

**Options:**
- **Option A:** Route all multi-collection saves through the atomic path. This makes `saveData()` and `disconnect()` as safe as transaction commit.
- **Option B:** Keep `save()`/`saveDirty()` as best-effort and document it explicitly. Narrow the "atomic persistence" claim to transaction commits only.

**Outcome:** Whichever option is chosen, the documented semantics must match the implementation. No implicit atomicity claims.

**Scope:** `src/engine/persistence.js` - `save()` / `saveDirty()` paths.

**Test:**
1. Inject failure on second collection write during `saveData()`. Assert the documented semantics hold (either atomic rollback or documented best-effort with detectable state).

**Depends on:** alpha.2 #8

---

### 10. Implement database-level save mutex (`_saveLock`)

**Issue:** None  
**Severity:** P1 - high  
**Effort:** Small

**Problem:** `saveAtomic()` (transaction commit) and `saveDirty()` (autoSave /
disconnect) can be in flight simultaneously. There is no database-level lock. Race
scenario: transaction snapshots payloads → autoSave writes newer data → transaction
overwrites with older snapshot.

**Fix:** Add a `_saveLock` promise chain on the Skalex instance, mirroring the existing
`_txLock` pattern. All save paths acquire the lock:

```js
// Constructor:
this._saveLock = Promise.resolve();

// In every save entry point:
const run = async () => { /* save logic */ };
const next = this._saveLock.then(run);
this._saveLock = next.catch(() => {});
return next;
```

**Scope:** `src/engine/persistence.js` - wrap `save()` and `saveAtomic()`.

**Test:**
1. Start a transaction that touches collection A
2. Trigger `saveDirty()` concurrently (simulating autoSave)
3. Assert no data loss - both saves complete without overwriting each other
4. Assert serialization - second save waits for first to finish

**Depends on:** None

---

### 11. Make `FieldIndex.update()` atomic

**Issue:** None  
**Severity:** P1 - high  
**Effort:** Small

**Problem:** `update(oldDoc, newDoc)` calls `remove(oldDoc)` then `_indexDoc(newDoc)`.
If `_indexDoc()` throws (e.g. unique constraint on a different field), the old document
is already removed from the index. The document becomes invisible to index-based queries
while still existing in `_data`.

**Fix:** Wrap the re-index in a try/catch that restores the old document on failure:

```js
update(oldDoc, newDoc) {
  this._checkUnique(newDoc, oldDoc);
  this.remove(oldDoc);
  try {
    this._indexDoc(newDoc);
  } catch (error) {
    this._indexDoc(oldDoc);  // restore old index entries
    throw error;
  }
}
```

**Scope:** `src/engine/indexes.js` - `update()` method.

**Test:**
1. Update a document where the new value violates a unique constraint on a
   different indexed field. Assert the original document remains findable via index
   lookup after the error.
2. Successful update - assert old value is gone from index and new value is present.

**Depends on:** None

---

## P2 - Query/Index Correctness

Original alpha-2 plan items, preserved with full option analysis.

### 12. Fix plain-object filter matching

**Issue:** None  
**Severity:** P2 - medium  
**Effort:** Small

**Problem:** In [query.js:56-73](../src/engine/query.js#L56), when a filter value is a plain object without `$` operator keys, it falls to the else branch which uses `!==` (reference equality). `{ metadata: { a: 1 } }` as a filter will never match a document with the same structure.

**Fix:** Detect plain-object filter values (no `$` keys) and apply structural equality (recursive deep-equal or `JSON.stringify` comparison). Must not regress operator object detection - objects with `$` keys must still be treated as operator expressions.

**Scope:** `src/engine/query.js` - `matchesFilter()`.

**Test:** Query `{ metadata: { a: 1 } }` against a document with `metadata: { a: 1 }` (different object reference). Assert match.

**Depends on:** None

---

### 13. Prevent compound-index key collisions for non-scalars

**Issue:** None  
**Severity:** P2 - medium  
**Effort:** Small

**Problem:** [indexes.js:35-41](../src/engine/indexes.js#L35) `encodeTuple()` falls back to `String(v)` for non-primitive values. Distinct objects collapse to `"[object Object]"`, producing false compound index matches.

**Fix options:**
- **Option A (preferred):** Enforce scalar-only compound index fields at index creation time. Throw `ValidationError` if an indexed field contains an object, array, or Date value. Simplest, prevents the problem at the source.
- **Option B:** Make encoding collision-safe (e.g., `JSON.stringify` for objects, `.toISOString()` for Dates). More permissive but adds encoding complexity and performance cost.

**Release decision:** alpha.2 should prefer Option A unless there is a strong product requirement for non-scalar compound keys. It is smaller, easier to reason about, and removes a correctness trap immediately.

**Scope:** `src/engine/indexes.js` - `encodeTuple()` and/or `_indexDoc()`.

**Test:** Create a compound index, insert two docs with different object values in the indexed field. Assert they do not collide (either rejection at insert time or distinct index entries).

**Depends on:** None

---

## P2.5 - Correctness Hardening (from architecture assessment)

Small fixes that prevent silent wrong behavior. All trivial to small effort.

### 14. Fix `insertOne` `ifNotExists` leaking raw mutable internal doc

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Problem:** `insertOne()` with `ifNotExists` returns the raw internal document directly
(`collection.js:80`) - no `stripVector()`, no copy. Exposes `_vector` and gives caller
a mutable reference to internal state.

**Fix:** `if (existing) return stripVector({ ...existing });`

**Scope:** `src/engine/collection.js` - `insertOne()` ifNotExists path.

**Test:**
1. Insert a doc, then `insertOne` with same key and `ifNotExists: true`
2. Assert returned doc does not contain `_vector`
3. Mutate returned doc, assert internal state unchanged

**Depends on:** None

---

### 15. Add `ensureConnected()` to aggregation methods

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Problem:** `count()`, `sum()`, `avg()`, `groupBy()` call `_findAllRaw()` without
`ensureConnected()`. Silently return 0/null/{} before connect.

**Fix:** Add `await this._ctx.ensureConnected();` at the start of each method.

**Scope:** `src/engine/collection.js` - `count()`, `sum()`, `avg()`, `groupBy()`.

**Test:**
1. Call `count()` before `connect()` - assert triggers auto-connect and returns correct count
2. Call `sum()`, `avg()`, `groupBy()` before `connect()` - assert no silent zero/null

**Depends on:** None

---

### 16. Reject dot-notation fields in index declarations

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Small

**Problem:** Declaring an index on a dot-path field (e.g. `"profile.email"`) silently
produces false negatives. The index engine uses `doc[field]` (direct property access)
while the query engine uses `resolveDotPath()`. The index path returns zero candidates
without falling through to linear scan, causing `find()` and `findOne()` to miss
matching documents.

**Fix:** Validate index field names in `IndexEngine` constructor / `createStore()`.
Reject fields containing `.` with a clear error message.

**Scope:** `src/engine/indexes.js` - `IndexEngine` constructor / `createStore()`.

**Test:**
1. Declare an index on `"profile.email"` - assert throws `ValidationError`
2. Declare an index on `"email"` (no dot) - assert succeeds (no regression)

**Depends on:** None

---

### 17. Make `connect()` idempotent under concurrent calls

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Fix:**
```js
async connect() {
  if (this._connectPromise) return this._connectPromise;
  this._connectPromise = this._doConnect();
  return this._connectPromise;
}
```

**Scope:** `src/index.js` - `connect()` method.

**Test:**
1. Call `connect()` twice concurrently - assert only one load runs
2. Both promises resolve successfully

**Depends on:** None

---

### 18. Fix package `files` list breaking encrypted connector

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Problem:** `package.json` `files` includes `src/connectors` but not `src/engine/errors.js`
which `encrypted.js` imports. After `npm publish`, the import fails.

**Fix:** Add `"src/engine/errors.js"` to the `files` array, or inline the error class.

**Scope:** `package.json` - `files` array.

**Test:**
1. Run `npm pack`, install in temp dir
2. `import "skalex/connectors/encrypted"` - assert resolves without error

**Depends on:** None

---

### 19. Add TTL timer `.unref()` for graceful shutdown

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Fix:**
```js
this._ttlTimer = setInterval(() => this._sweepTtl(), this._ttlSweepInterval);
if (this._ttlTimer?.unref) this._ttlTimer.unref();
```

**Scope:** `src/engine/collection.js` - TTL timer setup.

**Test:**
1. Create collection with TTL, assert process can exit without hanging

**Depends on:** None

---

### 20. Strip `_vector` from explicit `select` projections

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Fix:** In `_projectDoc()`, exclude `_vector` from the select path unless an explicit
opt-in flag is provided.

**Scope:** `src/engine/collection.js` - `_projectDoc()`.

**Test:**
1. `findOne({}, { select: ["name"] })` on doc with `_vector` - assert `_vector` excluded
2. Explicit opt-in flag - assert `_vector` included

**Depends on:** None

---

### 21. Recursive dangerous-key stripping in `applyUpdate()`

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Small

**Problem:** `applyUpdate()` checks `__proto__`/`constructor`/`prototype` at top level
only. Nested assignment (`item[field] = updateValue`) stores dangerous keys as
potential pollution gadgets.

**Fix:** Strip forbidden keys recursively from `updateValue` before assignment.

**Scope:** `src/engine/collection.js` - `applyUpdate()`.

**Test:**
1. `updateOne` with nested `{ data: { __proto__: { polluted: true } } }` - assert `__proto__` stripped
2. Top-level dangerous key - assert still stripped (no regression)

**Depends on:** None

---

### 22. Fix `.d.ts` named exports that don't exist at runtime

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Small

**Problem:** `src/index.d.ts` declares named exports (`StorageAdapter`, `FsAdapter`,
`Collection`, all LLM/embedding adapters, etc.) but `src/index.js` only has
`export default Skalex`. Any consumer writing
`import { FsAdapter } from 'skalex'` gets a runtime failure despite TypeScript
accepting it. The build script (`cp src/index.d.ts dist/skalex.d.ts`) copies
the mismatch into `dist/`.

**Fix:** Either:
- **(A)** Re-export adapter classes and error types from `src/index.js` as named
  exports (preserving the default Skalex export), or
- **(B)** Remove the named class declarations from `src/index.d.ts` and add
  separate `.d.ts` files for each connector subpath.

Option A is simpler and matches consumer expectations set by the existing `.d.ts`.

**Scope:** `src/index.js`, `src/index.d.ts`.

**Test:**
1. `import { FsAdapter } from 'skalex'` - assert resolves at runtime (not just TS)
2. `import Skalex from 'skalex'` - assert default export still works

**Depends on:** None

---

### 23. Fix subpath exports mixing `dist/` and `src/`

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Small

**Problem:** `package.json` serves the main entry from `dist/` (bundled by Rollup
with browser stubs and tree-shaking) while connector subpaths
(`skalex/connectors/fs`, `skalex/connectors/encrypted`, etc.) point directly to
raw `src/connectors/` ESM source with `node:*` static imports. Consumers get
different compatibility characteristics depending on which entry point they use.

**Fix:** Either:
- **(A)** Build connector subpaths into `dist/connectors/*` via Rollup and
  update `exports` to point there, or
- **(B)** Include all transitive `src/` dependencies in `files` (which #18
  partially does) and document that connector subpaths are raw ESM requiring
  a compatible runtime or bundler.

Option A is cleaner for consumers.

**Scope:** `package.json` - `exports` map, `rollup.config.js`.

**Test:**
1. `npm pack` + install, import all `exports` subpaths - assert consistent resolution
2. No mixed `dist/` and `src/` imports in consumer context

**Depends on:** alpha.2 #18

---

### 24. Export base adapter classes from connector barrels

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Problem:** Consumers cannot write custom adapters that properly extend the
base classes. All three connector barrel files export only concrete adapters,
not `StorageAdapter`, `EmbeddingAdapter`, or `LLMAdapter`. The `.d.ts`
declares them as exported types, but no runtime barrel provides them.

**Fix:** Add to each barrel:

```js
// src/connectors/storage/index.js
export { default as StorageAdapter } from "./base.js";

// src/connectors/embedding/index.js
export { default as EmbeddingAdapter } from "./base.js";

// src/connectors/llm/index.js
export { default as LLMAdapter } from "./base.js";
```

Also add to `src/connectors/index.js` (full barrel).

**Scope:** `src/connectors/storage/index.js`, `src/connectors/embedding/index.js`, `src/connectors/llm/index.js`, `src/connectors/index.js`.

**Test:**
1. `import { StorageAdapter } from 'skalex/connectors/storage'` - assert resolves
2. `import { EmbeddingAdapter } from 'skalex/connectors/embedding'` - assert resolves
3. `import { LLMAdapter } from 'skalex/connectors/llm'` - assert resolves

**Depends on:** None

---

### 25. Short-circuit `stripVector` when no `_vector` present

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Problem:** `stripVector()` in `vector.js:41-44` creates a shallow copy
(`{ ...doc }`) and deletes `_vector` on every returned document, even those
without a `_vector` field. This runs on every query result.

**Fix:**

```js
function stripVector(doc) {
  if (!("_vector" in doc)) return doc;
  const { _vector, ...rest } = doc;
  return rest;
}
```

**Note:** This changes the defensive-copy semantics for non-vector documents.
If external mutation protection is required on all results, keep the copy
and only optimize the no-vector path.

**Scope:** `src/engine/vector.js` - `stripVector()`.

**Test:**
1. `find()` on collection without embeddings - assert no unnecessary object copies
2. `find()` on collection with embeddings - assert `_vector` still stripped

**Depends on:** None

---

### 26. Fix `generateUniqueId` truncation discarding entropy

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Problem:** `utils.js:19` concatenates a hex timestamp (~11 chars) and 16 hex
random chars (27 total), then truncates to 24 via `.substring(0, 24)`. This
silently discards 12 bits of randomness from the random suffix.

**Fix:** Either increase the ID length to 27, reduce random bytes to 7
(14 hex chars → 25 total → truncate loses only 4 bits), or remove truncation
entirely and use a fixed-format output.

**Scope:** `src/engine/utils.js` - `generateUniqueId()`.

**Test:**
1. Generate 1000 IDs, assert all preserve full random suffix (no truncation)
2. Assert no duplicate IDs in batch

**Depends on:** None

---

### 27. Extract `typeOf()` utility in validator.js

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Problem:** The expression
`Array.isArray(val) ? "array" : val instanceof Date ? "date" : typeof val`
is duplicated verbatim at `validator.js:72` and `validator.js:108`.

**Fix:** Extract to a local `typeOf(val)` function and use in both locations.

**Scope:** `src/engine/validator.js` - extract `typeOf()` utility.

**Test:**
1. Code review: assert `typeOf()` used in both locations (no duplication)
2. Validate array, Date, and primitive types still detected correctly

**Depends on:** None

---

### 28. Fix `_detectIncompleteFlush()` using potentially wrong meta key

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Small

**Problem:** `persistence.js` `_detectIncompleteFlush()` reads the flush
sentinel from `metaCol.index.get("migrations")`. The sentinel is written
under the `_flush` key on the migrations meta document, but the lookup
assumes the meta document's `_id` is always `"migrations"`. If the meta
document key ever changes or the sentinel is stored differently, flush
corruption goes undetected silently.

**Fix:** Use the same `FLUSH_META_KEY` constant for both read and write
paths. Verify the sentinel round-trip in a test: write sentinel → load →
assert detection fires.

**Scope:** `src/engine/persistence.js` - `_detectIncompleteFlush()`, flush sentinel constants.

**Test:**
1. Write a flush sentinel (startedAt set, completedAt null), reload
   via `loadAll()`. Assert the warning is logged. Then clear the sentinel,
   reload. Assert no warning.

**Depends on:** None

---

### 29. Make corrupted collection files throw instead of loading as empty

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Small

**Problem:** `persistence.js` `loadAll()` catches deserialization errors
and logs a warning: `"Could not load collection - Collection will be empty"`.
A corrupted file silently becomes an empty collection. The next save
overwrites the corrupted file with empty data, permanently destroying it.

**Fix:** Default to throwing `PersistenceError` on deserialization failure.
Add an opt-in `{ lenientLoad: true }` option that preserves the current
warn-and-continue behavior for consumers who explicitly accept the risk.

**Scope:** `src/engine/persistence.js` - `loadAll()` deserialization error handling.

**Test:**
1. Write invalid JSON to a collection file, call `connect()`. Assert
   `PersistenceError` is thrown (not swallowed).
2. With `{ lenientLoad: true }`, assert warning is logged and collection
   loads as empty (existing behavior preserved).

**Depends on:** None

---

### 30. Prevent user spread from overwriting system fields on insert

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Trivial

**Problem:** `_buildDoc()` in `collection.js` sets `_id`, `createdAt`,
`updatedAt` first, then spreads user input with `...item`. A user passing
`{ _id: "custom", createdAt: someDate }` silently overwrites system fields
on the insert path. The update path correctly skips `_id` and `createdAt`,
but the insert path doesn't.

**Fix:** Spread user input first, then set system fields (reversing the order):

```js
const newItem = {
  ...item,
  _id: item._id ?? (this._ctx.idGenerator ?? generateUniqueId)(),
  createdAt: new Date(),
  updatedAt: new Date(),
};
```

This preserves user-provided `_id` (if intended via `idGenerator` or
explicit override) while always enforcing system timestamps.

**Note:** If user-provided `_id` should be rejected entirely, guard with:
`if ("_id" in item) throw new ValidationError(...)`.

**Scope:** `src/engine/collection.js` - `_buildDoc()`.

**Test:**
1. `insertOne({ _id: "user-set", createdAt: new Date(0) })`. Assert `_id`
   uses generator (not "user-set") and `createdAt` is recent (not epoch).
2. `insertOne({ name: "normal" })`. Assert works as before (no regression).

**Depends on:** None

---

### 31. Prevent `dump()` and projections from returning mutable references

**Issue:** None  
**Severity:** P2.5 - low  
**Effort:** Small

**Problem:** `dump()` in `registry.js` returns `[...store.data]` - a new
array but with the same object references as internal state. Callers can
mutate the returned documents and corrupt the database. Similarly,
`_projectDoc()` with `select` returns a new object but primitive values
are copies while object values are shared references.

**Fix:** `dump()` should return deep copies:

```js
dump() {
  const result = {};
  for (const name in this.stores) {
    if (!name.startsWith("_")) result[name] = structuredClone(this.stores[name].data);
  }
  return result;
}
```

For `_projectDoc()`, the current shallow copy is acceptable for query
results (consistent with MongoDB driver behavior), but document it.

**Scope:** `src/engine/registry.js` - `dump()`, `src/engine/collection.js` - `_projectDoc()`.

**Test:**
1. `dump()` → mutate returned doc → `findOne()` original. Assert original
   is unchanged.
2. `findOne()` → mutate returned doc → `findOne()` again. Document whether
   this is protected or not.

**Depends on:** None

---

## P3 - Housekeeping

### 32. Close implemented issues and update milestones

**Issue:** None  
**Severity:** P3 - housekeeping  
**Effort:** Small

**Close:**
- [#17](https://github.com/TarekRaafat/skalex/issues/17) (copy-on-write snapshots) - fully implemented
- [#18](https://github.com/TarekRaafat/skalex/issues/18) (transaction timeout) - fully implemented
- [#22](https://github.com/TarekRaafat/skalex/issues/22) (stale Collection instances) - fixed by alpha.2 #1
- [#23](https://github.com/TarekRaafat/skalex/issues/23) (upsert operator leak) - fixed by alpha.2 #2

**Update with current status:**
- [#6](https://github.com/TarekRaafat/skalex/issues/6) - partially addressed by alpha.2 #8 (saveAtomic fix). Update with what was implemented, what remains (FsAdapter not truly atomic, no WAL), link to the atomic persistence design doc
- [#12](https://github.com/TarekRaafat/skalex/issues/12) - partially addressed by alpha.2 #9 (save semantics) + #10 (save mutex). Update with the documented semantics decision

**Move milestones from alpha.2 to post-alpha.3:**
- [#19](https://github.com/TarekRaafat/skalex/issues/19) (out-of-band type metadata) - breaking change, deferred
- [#20](https://github.com/TarekRaafat/skalex/issues/20) (watch callback during tx flush test) - deferred
- [#21](https://github.com/TarekRaafat/skalex/issues/21) (afterRestore plugin hook) - deferred

**Scope:** GitHub Issues - #6, #12, #17, #18, #19, #20, #21, #22, #23.

**Test:**
1. Verify #17, #18, #22, #23 are closed with correct resolution comments
2. Verify #6 and #12 are updated with current implementation status
3. Verify #19, #20, #21 are moved to post-alpha.3 milestone

**Depends on:** alpha.2 #1, alpha.2 #2, alpha.2 #8, alpha.2 #9, alpha.2 #10

---

### 33. Update #6 and #12 with current status

**Issue:** None  
**Severity:** P3 - housekeeping  
**Effort:** Trivial

See #32 above - consolidated into the close/update housekeeping item.

**Scope:** GitHub Issues - #6, #12.

**Test:**
1. Verify #6 and #12 issue comments reflect current implementation status

**Depends on:** alpha.2 #32

---

### 34. Document persistence guarantees per adapter

**Issue:** None  
**Severity:** P3 - housekeeping  
**Effort:** Small

Add a clear table to the user-facing docs:

| Guarantee | FsAdapter | BunSQLite | D1 | LibSQL |
|--|--|--|--|--|
| Single-write atomicity | Yes (temp+rename) | Yes (SQLite) | Yes | Yes |
| Cross-collection atomicity | Best-effort | Yes (transaction) | Yes (batch) | Yes (batch) |
| Crash detection | Sentinel (warning) | Automatic (WAL) | Automatic | Automatic |
| Power-loss durability | No | Yes | Yes | Yes |

For primary-database use cases, recommend SQL-backed adapters.

**Scope:** User-facing docs / README.

**Test:**
1. Verify table is present in published docs
2. Verify each cell matches actual adapter behavior

**Depends on:** alpha.2 #8, alpha.2 #9

---

## Regression Test Requirements

Every P0/P1/P2/P2.5 fix must ship with at least one targeted regression test:

| Fix | Test scenario |
|---|--------|
| #1 (stale instances) | `createCollection` → `connect` → `useCollection` returns loaded data |
| #2 (upsert leak) | Operator filter in upsert insert path → plain values stored |
| #3 (insertMany index) | `insertMany` with duplicate unique field → no ghost index entries, subsequent insert succeeds |
| #4 (tx isolation) | Non-tx insert during active tx sleep → survives tx rollback |
| #5 (stale proxy) | Use captured proxy after commit/timeout → throws `ERR_SKALEX_TX_STALE_PROXY` |
| #6 (save durability) | Two concurrent `{ save: true }` → both await actual disk write |
| #7 (restore persist) | `changelog.restore()` → data survives disconnect/reconnect |
| #8 (saveAtomic divergence) | Inject adapter failure on final `_meta` write → disk and memory consistent |
| #9 (save semantics) | Inject failure on second collection write during `saveData()` → documented semantics hold |
| #10 (save mutex) | Concurrent `saveAtomic` + `saveDirty` → no data loss or overwrite |
| #11 (index atomicity) | Failed re-index → old document still in index |
| #12 (plain-object filter) | Structural equality match on nested objects |
| #13 (compound collision) | Non-scalar compound key → rejected at insert |
| #14 (ifNotExists) | `insertOne({}, { ifNotExists })` returns stripped copy, not raw internal doc |
| #15 (aggregation connect) | `count()` before `connect()` → triggers auto-connect, returns correct count |
| #16 (dot-path index) | Declare index on `"profile.email"` → throws `ValidationError` |
| #17 (connect idempotent) | Two concurrent `connect()` → only one load runs |
| #18 (package files) | `npm pack` + temp install → `import "skalex/connectors/encrypted"` succeeds |
| #19 (TTL unref) | TTL timer does not prevent process exit |
| #20 (vector select) | `findOne({}, { select: ["_vector"] })` → `_vector` excluded unless opt-in |
| #21 (nested keys) | `applyUpdate` with nested `__proto__` → dangerous key stripped |
| #22 (d.ts exports) | `import { FsAdapter } from 'skalex'` resolves at runtime (not just TS) |
| #23 (dist/src mix) | All `exports` subpaths serve consistently processed code |
| #24 (base adapters) | `import { StorageAdapter } from 'skalex/connectors/storage'` resolves |
| #25 (stripVector) | `find()` on collection without embeddings → no unnecessary copies |
| #26 (ID entropy) | Generated IDs preserve full random suffix (no truncation) |
| #27 (typeOf) | Validator type detection uses shared utility (code review check) |
| #28 (flush sentinel) | Write incomplete sentinel → reload → assert detection warning fires |
| #29 (corrupt load) | Write invalid JSON → `connect()` → assert `PersistenceError` thrown |
| #30 (system fields) | `insertOne({ _id: "x", createdAt: epoch })` → system fields enforced |
| #31 (mutable dump) | `dump()` → mutate returned doc → assert internal state unchanged |

---

## Verification Matrix

alpha.2 is not done when only the new unit/integration tests pass. The release must also verify the advertised runtime surface:

- `npm test`
- `npm run smoke:node`
- `npm run smoke:bun`
- `npm run smoke:deno`
- browser smoke (`npm run smoke:browser`)

If any runtime is intentionally excluded from alpha.2 release claims, the docs must say so explicitly.

---

## Success Criteria

alpha.2 is ready only when all of the following are true:

1. `createCollection` → `connect` → `useCollection` returns loaded data (not empty).
2. `upsert` with operator filters stores resolved plain values (not operator objects).
3. `insertMany` with a partial unique violation leaves no ghost index entries.
4. Non-transactional writes during an active transaction are not captured by rollback.
5. Stale transaction proxy throws after commit/timeout - no unguarded mutations.
6. `{ save: true }` awaits actual disk write, not just enqueue.
7. `ChangeLog.restore()` persists restored state to disk.
8. A failed transaction never leaves disk committed while memory rolls back.
9. Multi-collection persistence semantics are explicit and match implementation.
10. Concurrent saves are serialized via `_saveLock`.
11. A failed index re-indexing restores the old document in the index.
12. Plain-object filter matching works by structure, not reference.
13. Compound indexes cannot silently collide on non-scalar values.
14. `insertOne` `ifNotExists` returns a stripped copy, not a raw internal reference.
15. Aggregation methods trigger auto-connect before reading data.
16. Dot-notation index fields are rejected at declaration time.
17. Concurrent `connect()` calls are idempotent (single load).
18. `npm pack` + install → all `exports` subpaths import successfully.
19. TTL timer does not prevent graceful process shutdown.
20. `_vector` is not returned through explicit `select` without opt-in.
21. Nested dangerous keys (`__proto__`, `constructor`, `prototype`) are stripped recursively.
22. Issues #17 and #18 are closed. Issues #6 and #12 are updated.
23. Persistence guarantees are documented per adapter.
24. All regression tests exist and pass.
25. The runtime verification matrix passes for every runtime included in release claims.
26. `import { FsAdapter } from 'skalex'` works at runtime (`.d.ts` matches JS exports).
27. All `exports` subpaths serve consistently processed code (no raw `src/` vs bundled `dist/` mismatch).
28. Base adapter classes (`StorageAdapter`, `EmbeddingAdapter`, `LLMAdapter`) are importable from connector barrels.
29. `stripVector()` short-circuits for documents without `_vector`.
30. `generateUniqueId()` preserves full random entropy (no silent truncation).
31. `typeOf()` utility replaces duplicated type-detection expression in `validator.js`.
32. Incomplete flush sentinel is detected on reload (correct meta key lookup).
33. Corrupted collection files throw `PersistenceError` by default (not silent empty).
34. User-provided `_id`/`createdAt` cannot overwrite system fields on insert.
35. `dump()` returns deep copies that cannot corrupt internal state.

---

## Out of Scope for alpha.2

The following are confirmed issues but can ship after alpha.2 (tracked in
`design/alpha-3.md` or the backlog):

| Item | Tracking |
|--|--|
| `_abortedIds` pruning (memory leak) | alpha.3 #1 |
| `createLLMAdapter()` silent null on unknown provider | alpha.3 #2 |
| D1 batch-size guard/chunking | alpha.3 #3 |
| Pipeline event ordering documentation | alpha.3 #4 |
| Migration idempotency / transactional wrapper | alpha.3 #5 |
| `_meta` store shape duplication | alpha.3 #6 |
| Out-of-band type metadata (#19) | post-alpha.3 (breaking change) - update GitHub milestone from alpha.2 |
| `afterRestore` plugin hook (#21) | post-alpha.3 - update GitHub milestone from alpha.2 |
| Watch callback during tx flush test (#20) | post-alpha.3 - update GitHub milestone from alpha.2 |
| Decompose `Skalex` god object (extract `SkalexAI`, `TtlScheduler`) | alpha.4 #1 |
| Decompose `Collection` god object (extract `VectorSearch`, `QueryPlanner`, etc.) | alpha.4 #2 |
| Backpressure / memory limits on watch event queues | alpha.4 #3 |
| `find()` full materialization before pagination | alpha.4 #4 |
| `structuredClone` optimization in hot update paths | alpha.4 #5 |
| `stats()` serialization performance | alpha.4 #6 |
| `FsAdapter` eager import for browser builds | alpha.4 #7 |
| Circular Skalex↔Collection coupling cleanup | alpha.4 #8 |
| `Symbol.toStringTag` / `Symbol.asyncDispose` | alpha.4 #9-#10 |
| FsAdapter `{ durable: true }` (fsync / F_FULLFSYNC) | post-alpha.4 (roadmap) |
| FsAdapter WAL | long-term roadmap |
| FsAdapter multi-process safety | long-term roadmap |
| Changelog retention / compaction | pre-GA |
| ANN vector indexing | pre-GA |
| `namespace()` capability checks | pre-GA |
| Transaction proxy hardening (beyond #4/#5 scope) | pre-GA |
| `RegExp` null/undefined coercion guard in query matching | pre-GA |
| `_serializeCollection` implicit coupling to default `onSchemaError` | pre-GA |

---

## Non-Goals

alpha.2 is not the release for:

- New features beyond bug fixes and correctness hardening
- ANN/vector index implementation
- Changelog compaction
- Adapter capability redesign
- Broad transaction sandboxing beyond public API expectations
- WAL or multi-process support
- Architecture restructuring (the refactor is done - this release is about fixing,
  testing, and documenting)

---

## Execution Order

Recommended sequence to minimize risk and maximize early signal:

**Phase 1 - P0 correctness (data loss / corruption bugs):**
1. **Fix #1** (stale instances) - smallest fix, highest user impact
2. **Fix #3** (insertMany index corruption) - small, self-contained
3. **Fix #4 + #5** (tx isolation + stale proxy) - implement as a unit, medium effort
4. **Fix #6** (write queue durability) - small, persistence.js only
5. **Fix #7** (changelog restore persist) - trivial, changelog.js only
6. **Fix #2** (upsert operator leak) - small, collection.js only

**Phase 2 - P1 persistence coherence:**
7. **Fix #10** (`_saveLock`) - moderate, follows existing `_txLock` pattern
8. **Fix #8** (saveAtomic divergence) - moderate, touches persistence core
9. **Fix #9** (save semantics decision) - depends on #8 outcome
10. **Fix #11** (index atomicity) - small, indexes.js only

**Phase 3 - P2 query/index correctness:**
11. **Fix #12** (plain-object filter) - small, isolated to query.js
12. **Fix #13** (compound collision) - small, isolated to indexes.js

**Phase 4 - P2.5 correctness hardening (trivial fixes):**
13. **Fixes #14-#21** - batch of trivial fixes (ifNotExists, aggregation connect,
    dot-path index rejection, connect idempotent, package files, TTL unref, vector
    select, nested key stripping)
14. **Fixes #22-#24** - package boundary fixes (d.ts exports, dist/src alignment,
    base adapter barrel exports). Do as a unit since they touch the same files.
15. **Fixes #25-#27** - micro-improvements (stripVector short-circuit, ID entropy,
    typeOf dedup). Independent trivial changes.
16. **Fixes #28-#31** - data integrity hardening (flush sentinel, corrupt load,
    system fields, mutable dump). Small fixes, high safety value.

**Phase 5 - Ship:**
17. **Housekeeping** (#32, #33, #34) - close/update issues, document guarantees
18. **Full verification matrix** - run all smoke tests across runtimes
19. **Version bump + CHANGELOG + tag** - ship alpha.2
