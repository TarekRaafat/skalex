# alpha.3 Release Plan

**Status:** Pending alpha.2 completion
**Version:** v4.0.0-alpha.3
**Prerequisite:** All alpha.2.1 items resolved and shipped.
**Gate:** alpha.3 does not ship until every item is resolved and covered by regression tests.
**Rule:** alpha.3 should reduce long-lived runtime risk and tighten the adapter/platform contract before new major feature work resumes.
**Theme:** Runtime safety, adapter consistency, code quality, and platform hardening.

---

## P0 - Runtime Safety

These fix silent runtime bugs that affect long-lived processes.

### 1. Prune `_abortedIds` in TransactionManager

**Issue:** None
**Severity:** P0 - critical
**Effort:** Small

**Problem:** [transaction.js:132](../src/engine/transaction.js#L132) adds aborted transaction IDs to `_abortedIds` but never removes them. In a long-lived process with repeated timeouts or aborted transactions, this Set grows without bound.

**Fix:** After clearing the transaction context in the `finally` block, prune IDs that are no longer reachable. A safe threshold is any ID below `_txIdCounter - N` where N is a reasonable window (e.g., 1000). Since transactions are serialized via promise-chain lock, no concurrent transaction can reference an ID that far behind the counter.

**Scope:** `src/engine/transaction.js`

**Test:** Run 100+ transactions with forced timeouts. Assert `_abortedIds.size` stays bounded.

**Depends on:** None

---

### 2. Make `createLLMAdapter()` throw on unknown provider

**Issue:** None
**Severity:** P0 - critical
**Effort:** Trivial

**Problem:** [adapters.js](../src/engine/adapters.js) - `createEmbeddingAdapter()` throws `AdapterError` on unknown provider, but `createLLMAdapter()` silently returns `null`. A provider typo (e.g., `"opanai"`) disables `db.ask()` with no warning.

**Fix:** Throw `AdapterError` with code `ERR_SKALEX_ADAPTER_UNKNOWN_PROVIDER` when the provider string does not match any known LLM adapter. Match the behavior of `createEmbeddingAdapter()`.

**Scope:** `src/engine/adapters.js`

**Test:** Call `createLLMAdapter({ provider: "unknown" })`. Assert it throws `AdapterError`.

**Depends on:** None

---

### 3. Add D1 batch-size guard

**Issue:** None
**Severity:** P0 - critical
**Effort:** Small

**Problem:** [d1.js:70-78](../src/connectors/storage/d1.js#L70) sends all statements in a single `d1.batch()` call. Cloudflare D1 has documented limits on batch size. Large commits will fail unpredictably at the platform level.

**Fix:** Chunk `writeAll()` entries into batches of a configurable max size (default ~100 statements). Each chunk is sent as a separate `d1.batch()` call. If a chunk fails, subsequent chunks are not attempted and the error propagates.

**Note:** This does not make cross-chunk writes atomic. If chunk 1 succeeds and chunk 2 fails, the first chunk's data is on disk. This is acceptable because D1's `batch()` is only atomic within a single call. Document this limitation.

**Scope:** `src/connectors/storage/d1.js`

**Test:** Mock a D1 binding, pass 250 entries to `writeAll()`. Assert multiple `batch()` calls were made, each within the size limit.

**Depends on:** None

---

### 4. Make `_enforceCapAfterInsert()` atomic

**Issue:** None
**Severity:** P0 - critical
**Effort:** Small

**Problem:** `_enforceCapAfterInsert()` in `collection.js` splices evicted documents and calls `_removeFromIndex()` per document. If `_removeFromIndex()` throws during eviction, some documents are removed from `_data` but remain in the field index (or vice versa), causing data/index inconsistency.

**Fix:** Collect eviction candidates first, then remove from all indexes in a try/catch that restores on failure (same pattern as alpha.2 #11 for `FieldIndex.update()`).

**Additional fix (eviction event gap):** FIFO eviction happens after the insert event is emitted ([pipeline.js:102-104](../src/engine/pipeline.js#L102)), so watch listeners see the insert but never receive a delete event for the evicted document(s). After `_enforceCapAfterInsert()` removes evicted documents, emit a `"delete"` event per evicted document via `ctx.emitEvent()` (same pattern as `deleteMany`).

**Scope:** `src/engine/collection.js`

**Test:**
1. Mock `_removeFromIndex` to throw on second call - assert `_data` and `_index` remain consistent after the error
2. Create a capped collection with `maxDocs: 3`, insert 4 documents, register a watch callback - assert a `"delete"` event is emitted for the evicted document alongside the `"insert"` event

**Depends on:** None

---

### 5. Fix `Memory.tokenCount()`/`context()` bypassing `ensureConnected`

**Issue:** None
**Severity:** P0 - critical
**Effort:** Trivial

**Problem:** `Memory.tokenCount()` and `Memory.context()` access `_col._data` directly without calling `ensureConnected()`. Before `connect()`, they return 0/empty string with no error.

**Fix:** Add `await this._col._ctx.ensureConnected()` or make these methods async. Alternatively, if they must stay synchronous, throw if not connected.

**Scope:** `src/engine/memory.js`

**Test:**
1. Create a `Memory` instance without calling `connect()`
2. Call `tokenCount()` - assert it throws or triggers auto-connect
3. Call `context()` - assert it throws or triggers auto-connect
4. Call `connect()`, then repeat both calls - assert they return valid results

**Depends on:** None

---

### 6. Fix `Memory` reading internal `_col._data` directly

**Issue:** None
**Severity:** P0 - critical
**Effort:** Small

**Problem:** `Memory._sortedData()` reads `this._col._data` (internal store array) instead of using the public `find()` API. This bypasses soft-delete filtering, auto-connect, and any future data-access hooks.

**Fix:** Replace `this._col._data` access with `await this._col.find({})` or equivalent public API call. Accept the async overhead - Memory operations are already async.

**Scope:** `src/engine/memory.js`

**Test:**
1. Create a `Memory` instance with soft-delete enabled on the underlying collection
2. Insert documents, soft-delete some
3. Call `_sortedData()` - assert soft-deleted documents are excluded
4. Verify `_sortedData()` returns the same results as `find({})`

**Depends on:** None

---

## P1 - DRY & Architecture Cleanup

Internal code quality improvements that reduce maintenance burden.

---

### 7. Unify `_meta` store creation

**Issue:** None
**Severity:** P1 - high
**Effort:** Small

**Problem:** [persistence.js:308-338](../src/engine/persistence.js#L308) manually constructs a `_meta` collection store with all 16 fields, duplicating the shape defined in [registry.js:54-98](../src/engine/registry.js#L54). If one changes, the other can silently diverge.

**Fix:** Replace the manual construction in `_getOrCreateMeta()` with a call to `registry.createStore("_meta")`. The persistence manager will need a reference to the registry (passed via constructor or a method parameter).

**Scope:** `src/engine/persistence.js`, `src/engine/registry.js`

**Test:** Existing persistence tests should continue to pass. Add an assertion that `collections["_meta"]` has the same shape as a store created via `registry.createStore()`.

**Depends on:** None

---

### 8. Complete store shape deduplication across `persistence.js`

**Issue:** None
**Severity:** P1 - high
**Effort:** Small

**Problem:** alpha.3 #7 unifies `_getOrCreateMeta()` to use the registry's `createStore()`. But `persistence.js:loadAll()` (lines 75-93) independently rebuilds the same 16-field collection store shape when loading from disk. If a new store field is added to `registry.createStore()`, the load path must be updated separately or loaded collections will have a different shape.

**Fix:** After deserializing collection data, call the registry's `createStore()` to build the canonical shape, then merge loaded data/options into it. This ensures all stores - whether created at runtime, loaded from disk, or auto-created for `_meta` - pass through the same construction path.

**Scope:** `src/engine/persistence.js`, `src/engine/registry.js`

**Test:** Add a store field to `createStore()`. Assert it appears on collections created via `createCollection()`, loaded via `connect()`, and auto-created for `_meta`.

**Depends on:** alpha.3 #7

---

### 9. Consolidate dual `_getMeta` / `_saveMeta` management

**Issue:** None
**Severity:** P1 - high
**Effort:** Medium

**Problem:** `Skalex._getMeta()` / `_saveMeta()` in `src/index.js:692-712` and `PersistenceManager._getOrCreateMeta()` in `persistence.js:308-338` both manipulate the `_meta` collection independently. The Skalex class reaches directly into `this.collections["_meta"].index.get("migrations")` while `PersistenceManager` creates meta stores from scratch. Two owners of the same data structure.

**Fix:** Move `_getMeta()` and `_saveMeta()` into `PersistenceManager` as `getMeta()` and `updateMeta(data)`. The Skalex class calls `this._persistence.getMeta()` and `this._persistence.updateMeta(data)` instead of reaching into the collections map. `_getOrCreateMeta()` becomes an internal detail of these methods.

**Scope:** `src/index.js`, `src/engine/persistence.js`

**Test:** Existing migration, query cache, and flush sentinel tests should continue to pass. Assert `Skalex` no longer accesses `collections["_meta"]` directly (code review check).

**Depends on:** alpha.3 #7

---

### 10. Share `_buildCollectionContext` across collection instances

**Issue:** None
**Severity:** P1 - high
**Effort:** Small

**Problem:** Every `Collection` instance receives a freshly allocated context object from `_buildCollectionContext()`. Since the context uses lazy getters that defer to the `db` instance, all contexts are functionally identical. Allocating one per collection is unnecessary.

**Fix:** Build the context once in the `Skalex` constructor (or lazily on first `useCollection`) and pass the shared reference to all `Collection` instances via the registry.

**Scope:** `src/index.js`, `src/engine/collection.js`

**Test:** Create 100 collections. Assert they all share the same `_ctx` reference (`col1._ctx === col2._ctx`).

**Depends on:** None

---

### 11. Remove `Collection.database` property

**Issue:** None
**Severity:** P1 - high
**Effort:** Trivial

**Problem:** `collection.js:20` sets `this.database = database`, exposing the full `Skalex` instance and breaking the encapsulation that `_ctx` was designed to provide. The class never uses `this.database` internally.

**Fix:** Remove `this.database = database`. If any external consumer relies on it, expose it as a getter on `_ctx` as a last resort (but verify first - it is not part of the documented API).

**Scope:** `src/engine/collection.js`

**Test:** `grep -r "\.database"` across tests. Fix any test that accesses `col.database` directly.

**Depends on:** alpha.3 #10

---

### 12. Extract soft-delete visibility guard

**Issue:** None
**Severity:** P1 - high
**Effort:** Small

**Problem:** The pattern `if (this._softDelete && item._deletedAt && !includeDeleted) continue/return` appears 6 times across `_findRaw` (3), `_findAllRaw` (2), and `find` (1).

**Fix:** Extract to a private method:

```js
_isVisible(doc, includeDeleted = false) {
  return !this._softDelete || !doc._deletedAt || includeDeleted;
}
```

Replace all 6 occurrences.

**Scope:** `src/engine/collection.js`

**Test:** Existing soft-delete tests provide full coverage. No new tests needed beyond verifying the refactor is behavior-preserving.

**Depends on:** None

---

### 13. Define constants for operations and hook names

**Issue:** None
**Severity:** P1 - high
**Effort:** Medium

**Problem:** Operation names (`"insert"`, `"update"`, `"delete"`, `"restore"`) and hook names (`"beforeInsert"`, `"afterInsert"`, etc.) are string literals scattered across `collection.js`, `pipeline.js`, `changelog.js`, `events.js`, and `plugins.js`.

**Fix:** Create `src/engine/constants.js`:

```js
export const Ops = {
  INSERT: "insert", UPDATE: "update",
  DELETE: "delete", RESTORE: "restore",
};
export const Hooks = {
  BEFORE_INSERT: "beforeInsert", AFTER_INSERT: "afterInsert",
  BEFORE_UPDATE: "beforeUpdate", AFTER_UPDATE: "afterUpdate",
  BEFORE_DELETE: "beforeDelete", AFTER_DELETE: "afterDelete",
  BEFORE_FIND: "beforeFind",    AFTER_FIND: "afterFind",
  BEFORE_SEARCH: "beforeSearch", AFTER_SEARCH: "afterSearch",
};
```

Replace all string literals. Mechanical find-replace.

**Scope:** `src/engine/constants.js` (new), `src/engine/collection.js`, `src/engine/pipeline.js`, `src/engine/changelog.js`, `src/engine/events.js`, `src/engine/plugins.js`

**Test:** Existing mutation/hook tests pass (behavior-preserving). Assert constants are exported and match expected values.

**Depends on:** None

---

### 14. Simplify `namespace()` config forwarding

**Issue:** None
**Severity:** P1 - high
**Effort:** Small

**Problem:** `namespace()` at `index.js:353-373` rebuilds the full config object with 15+ conditional ternaries. Every new config option requires a new line here, and omitting one silently breaks namespace inheritance.

**Fix:** Store the original constructor config:

```js
constructor(config = {}) {
  this._config = config;
  // ... existing init
}
namespace(id) {
  return new Skalex({
    ...this._config,
    path: `${this.dataDirectory}/${safeId}`,
  });
}
```

**Scope:** `src/index.js`

**Test:** Create a `Skalex` instance with all config options set. Call `namespace("sub")`. Assert the child inherits every option except `path`.

**Depends on:** None

---

### 15. Fix TTL sweep O(n^2) splice loop

**Issue:** None
**Severity:** P1 - high
**Effort:** Small

**Problem:** `ttl.js:63-71` iterates backward with `data.splice(i, 1)` per expired doc. For `n` documents with `k` expired, this is O(n*k) due to array shifting on each splice.

**Fix:** Use the filter-and-reassign pattern already used by `deleteMany`'s `hardMany` mode:

```js
const remaining = [];
for (const doc of data) {
  if (doc._expiresAt && new Date(doc._expiresAt).getTime() <= now) {
    idIndex.delete(doc._id);
    if (removeFromIndexes) removeFromIndexes(doc);
    removed++;
  } else {
    remaining.push(doc);
  }
}
data.length = 0;
data.push(...remaining);
```

**Scope:** `src/engine/ttl.js`

**Test:** Existing TTL sweep tests. Add a benchmark with 10k docs / 5k expired to verify linear behavior.

**Depends on:** None

---

### 16. Move orphan temp-file cleanup to `FsAdapter`

**Issue:** None
**Severity:** P1 - high
**Effort:** Small

**Problem:** `persistence.js:284-306` dynamically imports `node:fs` and `node:path` for orphan cleanup. This is filesystem-specific logic inside a universal persistence module. The `catch {}` silently swallows failures in browsers.

**Fix:** Add a `cleanOrphans()` method to `FsAdapter` (where `node:fs` is already imported). Call it from `PersistenceManager.loadAll()` via `this._adapter.cleanOrphans?.()`.

**Scope:** `src/connectors/storage/fs.js`, `src/engine/persistence.js`

**Test:** Existing orphan cleanup tests. Verify browser builds don't trigger the code path.

**Depends on:** None

---

## P2 - Security, Documentation & Tooling

---

### 17. Document `updatedAt` as system-managed

**Issue:** None
**Severity:** P2 - medium
**Effort:** Trivial

**Problem:** `applyUpdate()` skips `_id` and `createdAt` (immutable), but not `updatedAt`. A user can pass `{ updatedAt: someDate }` in an update - the value is applied, then immediately overwritten by `item.updatedAt = new Date()` at line 254. The user's value is silently discarded.

**Fix:** Either skip `updatedAt` in the `applyUpdate` loop (like `createdAt`), or document that it is system-managed and user-provided values are overwritten. Skipping is more consistent.

**Scope:** `src/engine/collection.js`

**Test:**
1. Insert a document
2. Call `updateOne` with `{ updatedAt: new Date("2000-01-01") }`
3. Assert the document's `updatedAt` is not the user-provided date
4. Assert `updatedAt` is a recent timestamp (system-managed)

**Depends on:** None

---

### 18. Document snapshot isolation semantics

**Issue:** None
**Severity:** P2 - medium
**Effort:** Small

**Problem:** Transactions use lazy snapshots - only collections that receive a write are snapshotted on first mutation. Reads on untouched collections see live data, including mutations from outside the transaction. Developers expecting full ACID snapshot isolation will encounter silent stale reads.

**Fix:** Add explicit documentation (JSDoc on `transaction()` and in user-facing docs) stating:
- Skalex provides **read-committed** isolation, not snapshot isolation
- Only written collections are rolled back on failure
- Reads on non-written collections see the latest committed state
- For full isolation, the caller should read-then-write to trigger a snapshot
- Transaction timeout is cooperative, not preemptive - the timeout rejects the promise but does not cancel in-flight mutations. Mutations continue until they reach an `assertTxAlive()` check.

**Scope:** `src/index.js`, `src/engine/transaction.js`

**Test:**
1. Start a transaction, read collection A (don't write), mutate collection A from outside, read A again inside transaction - assert the second read sees the external mutation (documenting current behavior)
2. Start a transaction with `{ timeout: 50 }`, perform a mutation that takes >50ms (e.g., mock embedding adapter with delay) - assert the transaction rejects with `ERR_SKALEX_TX_TIMEOUT` and rollback is clean

**Depends on:** None

---

### 19. Address `onSchemaError: "warn"` schema drift risk

**Issue:** None
**Severity:** P2 - medium
**Effort:** Small

**Problem:** `onSchemaError: "warn"` silently admits invalid documents with only a console log. Over time, collections accumulate documents that violate the schema with no audit trail. Consumers may not notice the warnings.

**Fix:** When `onSchemaError` is `"warn"`, log the document `_id` and the specific validation errors. Optionally, record warnings in the changelog (if enabled) so drift is auditable. At minimum, document that `"warn"` mode does not prevent invalid data from being persisted.

**Scope:** `src/engine/collection.js`

**Test:**
1. Create a collection with a schema and `onSchemaError: "warn"`
2. Insert a document that violates the schema
3. Assert the document is persisted (not rejected)
4. Assert a warning was logged containing the document `_id` and validation errors

**Depends on:** None

---

### 20. Design error handling for post-commit deferred effects

**Issue:** None
**Severity:** P2 - medium
**Effort:** Medium

**Problem:** Two related issues:
1. After `saveAtomic()` commits, deferred side effects (watch callbacks, after-hooks, changelog entries) are flushed. If one throws, persistence is done but subsequent effects are skipped. No recovery path.
2. After-hook errors are swallowed differently inside vs outside transactions. No configurable strategy.

**Fix:** Add a configurable error strategy for deferred effects:
- `"throw"` - re-throw after flushing all effects (collect errors, throw aggregate after all effects run)
- `"warn"` - log and continue (current implicit behavior)
- `"ignore"` - suppress entirely

Ensure ALL deferred effects run regardless of individual failures (don't short-circuit on first error).

**Note:** Event emission in [pipeline.js:102-104](../src/engine/pipeline.js#L102) is synchronous - a slow watch listener blocks the mutation pipeline. Recommend keeping synchronous dispatch (preserves ordered delivery guarantees) but document this as an explicit contract in the JSDoc on `execute()`. If async dispatch is needed later, it can be added as a separate config option.

**Scope:** `src/engine/pipeline.js`, `src/index.js`

**Test:**
1. Register three after-hooks where the second throws
2. Perform an insert that triggers all three hooks
3. Assert all three hooks were called (no short-circuit)
4. Assert the error from the second hook is surfaced per the configured strategy

**Depends on:** None

---

### 21. Document and cap `$fn`/`$regex` security surface

**Issue:** None
**Severity:** P2 - medium
**Effort:** Small

**Problem:** `$fn` operator accepts arbitrary functions in filters - this is intentional for local use but undocumented as a security surface. `$regex` has a length cap in `ask()` (LLM-generated filters) but NOT in direct `matchesFilter()` calls. A user-provided regex can cause ReDoS.

**Fix:**
1. Document `$fn` as a power-user feature with a security warning: "Do not pass user-controlled functions to `$fn`."
2. Apply the existing `regexMaxLength` cap to `matchesFilter()` when the regex comes from a string (not a pre-compiled `RegExp` instance).
3. Add the ReDoS nested-quantifier check from `ask.js` to `query.js`.
4. Strip `$fn` from MCP-sourced filters. The MCP tool handler in [tools.js](../src/connectors/mcp/tools.js) accepts filter objects from AI agents. An AI-crafted filter containing `$fn` would execute arbitrary JavaScript in the host process. Add a `sanitizeFilter(filter)` helper that recursively walks the filter tree (including inside `$or`, `$and`, `$not` branches) and deletes any `$fn` keys. Call it in `callTool()` before passing filters to the Collection API. Log a warning when a `$fn` is stripped.

**Scope:** `src/engine/query.js`, `src/features/ask.js`, `src/connectors/mcp/tools.js`

**Test:**
1. Call `find()` with a `$regex` string exceeding `regexMaxLength` - assert it throws
2. Call `find()` with a pre-compiled `RegExp` exceeding the length - assert it is allowed
3. Call `find()` with a `$regex` containing nested quantifiers - assert it throws
4. Send an MCP `skalex_find` request with a filter containing `$fn` - assert the `$fn` key is stripped before query execution and a warning is logged

**Depends on:** None

---

### 22. Document pipeline event ordering contract

**Issue:** None
**Severity:** P2 - medium
**Effort:** Trivial

**Problem:** In [pipeline.js:95-108](../src/engine/pipeline.js#L95), events are emitted before after-hooks complete. If an after-hook throws, observers have already seen the mutation event.

**Decision:** Either reorder (events after all hooks) or document the current behavior as intentional. The key requirement is that the contract is explicit, not accidental.

**If keeping current order:** Add a JSDoc comment on `execute()` stating: "Events are emitted before after-hooks. Observers may see events for mutations whose after-hooks subsequently fail."

**If reordering:** Move the event emission block (lines 96-98) to after the after-hook block (after line 108). Verify no tests depend on the current ordering.

**Scope:** `src/engine/pipeline.js`

**Test:**
1. Register a watch callback and an after-hook on the same collection
2. Perform an insert - record the order of callback invocations
3. Assert the order matches the documented contract

**Depends on:** None

---

### 23. Document migration idempotency requirement

**Issue:** None
**Severity:** P2 - medium
**Effort:** Small

**Problem:** [migrations.js:43-54](../src/engine/migrations.js#L43) runs pending migrations sequentially and records a version only after `up()` returns. If a migration partially mutates state and crashes, it will re-run on next `connect()`.

**Fix (minimum):** Add explicit documentation (JSDoc on `add()` and in user-facing docs) stating that migrations must be idempotent. Provide examples of safe patterns (upsert, check-before-mutate) and unsafe patterns (blind increment, append without dedup).

**Fix (preferred, if scoped):** Wrap each migration's `up()` call in a transaction, so partial application is rolled back on failure.

**Scope:** `src/engine/migrations.js`

**Test:**
1. Register a migration that partially mutates state then throws
2. Call `connect()` - assert the migration fails
3. Call `connect()` again - assert the migration re-runs (not skipped)
4. If wrapped in transaction, assert partial mutations were rolled back

**Depends on:** None

---

### 24. Document no-nested-transactions limitation

**Issue:** None
**Severity:** P2 - medium
**Effort:** Trivial

**Problem:** Skalex transactions are serialized via promise-chain lock. Calling `db.transaction()` inside another transaction deadlocks. This is undocumented.

**Fix:** Add JSDoc on `transaction()` stating: "Transactions cannot be nested. Calling `transaction()` inside a transaction callback will deadlock." Add a runtime detection that throws `TransactionError` if `_ctx` is already active when `run()` is called.

**Scope:** `src/engine/transaction.js`, `src/index.js`

**Test:**
1. Call `db.transaction()` inside another `db.transaction()` callback
2. Assert it throws `TransactionError` (if runtime detection is added) or document the deadlock behavior

**Depends on:** None

---

### 25. Add `TransactionOptions` to type declarations

**Issue:** None
**Severity:** P2 - medium
**Effort:** Trivial

**Problem:** `src/index.d.ts` declares `transaction(fn)` but omits the options parameter. TypeScript users cannot pass `{ timeout: 5000 }`.

**Fix:** Add to `src/index.d.ts`:

```ts
interface TransactionOptions {
  timeout?: number;
}
transaction<R = unknown>(fn: (db: Skalex) => Promise<R>, opts?: TransactionOptions): Promise<R>;
```

**Scope:** `src/index.d.ts`

**Test:**
1. Compile a TypeScript file that calls `db.transaction(fn, { timeout: 5000 })`
2. Assert compilation succeeds without type errors

**Depends on:** None

---

### 26. Add input validation on public API boundaries

**Issue:** None
**Severity:** P2 - medium
**Effort:** Medium

**Problem:** Public methods like `insertOne`, `updateOne`, `find`, `deleteOne` don't validate argument types. `insertOne(null)`, `insertOne("string")`, or `find(123)` fail deep inside with unclear errors.

**Fix:** Add lightweight guards at the top of each public method:

```js
async insertOne(item, options = {}) {
  if (item == null || typeof item !== "object" || Array.isArray(item))
    throw new ValidationError("ERR_SKALEX_VALIDATION_ARG",
      "insertOne() expects a plain object", { got: typeof item });
  // ...
}
```

Apply to: `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `upsert`, `upsertMany`, `find`, `findOne`, `search`.

**Additional fix (collection name sanitization):** `useCollection()` and `createCollection()` accept arbitrary strings as collection names. A name like `../../../etc/passwd` or one containing null bytes could cause path traversal in `FsAdapter._filePath()`. Add a validation guard in `CollectionRegistry.get()` and `CollectionRegistry.create()`:

```js
const _COLLECTION_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,63}$/;
if (!_COLLECTION_NAME_RE.test(name))
  throw new ValidationError("ERR_SKALEX_VALIDATION_COLLECTION_NAME",
    `Invalid collection name "${name}". Names must be 1-64 alphanumeric characters (plus _ . : -), starting with a letter, digit, or underscore.`,
    { name });
```

Internal collections (`_meta`, `_changelog`, `_memory`) use `_` prefix and pass this check.

**Scope:** `src/engine/collection.js`, `src/engine/registry.js`

**Test:**
1. For each CRUD method, assert that null, string, number, and array arguments throw `ValidationError` with a clear message
2. Call `useCollection("../etc/passwd")` - assert it throws `ValidationError` with code `ERR_SKALEX_VALIDATION_COLLECTION_NAME`
3. Call `useCollection("valid_name-1.0")` - assert it succeeds
4. Call `useCollection("")` - assert it throws
5. Call `useCollection("a\x00b")` - assert it throws

**Depends on:** None

---

### 27. Add type declaration validation to CI

**Issue:** None
**Severity:** P2 - medium
**Effort:** Small

**Problem:** `src/index.d.ts` is hand-maintained and simply copied during build. No automated check verifies that type declarations match runtime behavior. Given the 695-line public API surface, drift is likely.

**Fix:** Add `tsd` or `expect-type` smoke tests:

```ts
// test/types.test-d.ts
import { expectType } from "tsd";
import Skalex, { Collection, StorageAdapter } from "../dist/skalex.js";

const db = new Skalex();
expectType<Promise<void>>(db.connect());
const col = db.useCollection("test");
expectType<Promise<{ docs: any[] }>>(col.find());
```

Add `"types:check": "tsd"` to `package.json` scripts.

**Scope:** `src/index.d.ts`, `test/types.test-d.ts` (new), `package.json`

**Test:**
1. Run `npm run types:check` - assert it passes
2. Introduce a deliberate type mismatch in the test file - assert `tsd` catches it

**Depends on:** None

---

### 28. Add lint, format, and static analysis tooling

**Issue:** None
**Severity:** P2 - medium
**Effort:** Medium

**Problem:** No linting, formatting, import-cycle detection, or type validation in `package.json` scripts or CI.

**Fix:** Add:

- `eslint` with a standard config (e.g. `eslint:recommended` + `plugin:import`)
- `prettier` in check mode
- `madge --circular src/` for import cycle detection
- Wire into CI alongside existing `test` and `smoke` scripts

Add scripts:
```json
"lint": "eslint src/ tests/",
"format:check": "prettier --check src/ tests/",
"deps:check": "madge --circular src/"
```

**Additional fix (vitest coverage exclude path):** [vitest.config.js:11](../vitest.config.js#L11) excludes `"src/adapters/storage/d1.js"` but the directory is `src/connectors/`, not `src/adapters/`. The exclude silently matches nothing. Change to `"src/connectors/storage/d1.js"`.

**Scope:** `package.json`, `.eslintrc.*` (new), `.prettierrc` (new), `vitest.config.js`

**Test:**
1. Run `npm run lint` - assert it passes with no errors
2. Run `npm run format:check` - assert all files are formatted
3. Run `npm run deps:check` - assert no circular imports
4. Run `npm run test:coverage` - assert `src/connectors/storage/d1.js` is excluded from the coverage report

**Depends on:** None

---

### 29. Clarify runtime verification and adapter guarantees

**Issue:** None
**Severity:** P2 - medium
**Effort:** Large

**Problem:** The current test surface is strongest in Node + in-memory paths. Some adapter/runtime claims are only partially exercised, especially around failure behavior and batch semantics.

**Fix:**
- Expand failure-path coverage for `FsAdapter.writeAll()` (rename failure, orphan cleanup).
- Add focused coverage for `BunSQLiteAdapter`, `D1Adapter`, and `LibSQLAdapter` batch semantics where their runtimes are available.
- Make release docs explicit about which adapters/runtimes are validated in CI versus supported by contract only.
- Add MCP transport tests. Both `src/connectors/mcp/transports/stdio.js` (0% coverage) and `src/connectors/mcp/transports/http.js` (0% coverage) are production-facing integration surfaces with no test coverage. MCP is the primary AI agent integration path - transport-level bugs would be invisible until production.
- Verify SQL-backed adapters (`BunSQLiteAdapter`, `D1Adapter`, `LibSQLAdapter`) use a native database transaction (BEGIN/COMMIT) within `writeAll()` for true atomicity.

**Outcome:** alpha.3 should leave adapter and transport guarantees explicit instead of implied.

**Scope:** `src/connectors/storage/fs.js`, `src/connectors/storage/d1.js`, `src/connectors/storage/bun-sqlite.js`, `src/connectors/storage/libsql.js`, `src/connectors/mcp/transports/stdio.js`, `src/connectors/mcp/transports/http.js`

**Test:**
1. Run `FsAdapter.writeAll()` with a simulated rename failure - assert error propagates and orphan cleanup runs
2. Run batch operations on `D1Adapter`, `BunSQLiteAdapter`, and `LibSQLAdapter` - assert batch semantics match documentation
3. Verify release docs explicitly state which adapters are CI-validated vs. contract-only
4. Send a valid JSON-RPC request to stdio transport via `MockTransport` - assert correct response framing. Send a malformed request - assert error response, not crash
5. Start HTTP transport on a random port, send a valid POST with JSON-RPC body - assert 200. Send oversized body exceeding `maxBodySize` - assert 413 rejection. Verify SSE endpoint connects and receives events
6. Verify SQL adapter `writeAll()` uses native transaction (BEGIN/COMMIT) - mock or spy on the underlying driver to assert transaction boundaries

**Depends on:** None

---

## Regression Test Requirements

Every item must ship with at least one targeted regression test:

| Fix | Test scenario |
|-----|---------------|
| #1 (_abortedIds) | 100+ timed-out transactions - assert set stays bounded |
| #2 (LLM provider) | Unknown provider string - assert throws `AdapterError` |
| #3 (D1 batch) | 250 entries via `writeAll()` - assert chunked `batch()` calls |
| #4 (cap atomicity + eviction events) | Throw during eviction - assert data/index consistent. Capped insert emits delete event for evicted doc |
| #5 (Memory connect) | `tokenCount()` before connect - assert triggers auto-connect or throws |
| #6 (Memory _data) | Memory uses `find()` not `_data` directly (code review) |
| #7 (_meta unify) | `_meta` shape matches `createStore()` output |
| #8 (store dedup) | New store field appears on loaded, created, and _meta collections |
| #9 (meta consolidate) | Migration/query cache tests pass; no direct `_meta` access in Skalex |
| #10 (shared ctx) | 100 collections share same `_ctx` reference |
| #11 (remove database) | No test accesses `col.database` |
| #12 (soft-delete guard) | Existing soft-delete tests pass (behavior-preserving) |
| #13 (constants) | Existing mutation/hook tests pass (behavior-preserving) |
| #14 (namespace config) | Child inherits all config except `path` |
| #15 (TTL O(n)) | 10k docs / 5k expired - linear sweep |
| #16 (orphan FsAdapter) | Orphan cleanup works; browser builds skip it |
| #17 (updatedAt) | `applyUpdate` skips user-provided `updatedAt` |
| #18 (isolation + timeout docs) | Read inside tx sees external mutation on untouched collection. Cooperative timeout semantics documented and tested |
| #19 (warn drift) | Warn mode logs `_id` and errors |
| #20 (deferred errors) | All effects run even when one throws |
| #21 ($fn/$regex cap + MCP) | Regex length cap in `matchesFilter()`. `$fn` documented. `$fn` stripped from MCP filters |
| #22 (event ordering) | Documented or reordered; test verifies contract |
| #23 (migration idempotency) | Documented or wrapped in transaction |
| #24 (nested tx) | Nested `transaction()` call throws or documented as deadlock |
| #25 (TransactionOptions) | TypeScript compilation with `{ timeout }` succeeds |
| #26 (input validation + name sanitization) | null/string/number/array args throw `ValidationError`. Path-traversal collection names rejected |
| #27 (tsd) | `tsd` smoke tests pass |
| #28 (lint + vitest config) | `eslint`, `prettier --check`, `madge --circular` pass. Vitest coverage exclude path corrected to `src/connectors/storage/d1.js` |
| #29 (adapter + MCP transport coverage) | Adapter tests expanded or docs narrowed. MCP stdio + HTTP transports have basic request/response tests. SQL adapter `writeAll()` uses native transactions |

---

## Verification Matrix

alpha.3 is not done when only the new unit/integration tests pass. The release must also verify:

- `npm test`
- `npm run smoke:node`
- `npm run smoke:bun`
- `npm run smoke:deno`
- `npm run smoke:browser`
- `npm run lint` (new)
- `npm run format:check` (new)
- `npm run types:check` (new)

---

## Success Criteria

alpha.3 is done when:

1. Long-lived transaction aborts do not produce unbounded in-memory growth.
2. Adapter misconfiguration fails loudly and consistently.
3. D1 batching behavior is bounded and documented.
4. Cap enforcement eviction is atomic (no data/index inconsistency on failure) and emits delete events for evicted documents.
5. `Memory.tokenCount()`/`context()` don't return stale data pre-connect.
6. `Memory` uses public Collection API, not internal `_data` access.
7. `_meta` creation is owned by one store-construction path.
8. All collection stores (runtime, loaded, `_meta`) pass through the same construction path.
9. `_getMeta` / `_saveMeta` are consolidated in `PersistenceManager`.
10. `_buildCollectionContext` is shared across all collection instances.
11. `Collection.database` is removed; only `_ctx` provides access to the Skalex instance.
12. Soft-delete visibility guard uses a single `_isVisible()` method.
13. Operation and hook names use shared constants, not string literals.
14. `namespace()` inherits config via stored `_config`, not manual ternaries.
15. TTL sweep runs in O(n) time, not O(n*k).
16. Orphan temp-file cleanup lives in `FsAdapter`, not `PersistenceManager`.
17. `updatedAt` is skipped or documented as system-managed in `applyUpdate()`.
18. Snapshot isolation semantics are explicitly documented (read-committed, not snapshot), including cooperative timeout behavior.
19. `onSchemaError: "warn"` logs document `_id` and is documented as non-blocking.
20. Deferred effect errors have a configurable strategy and don't skip remaining effects.
21. `$fn` has a security warning; `$regex` length cap applies in `matchesFilter()`; `$fn` is stripped from MCP-sourced filters.
22. Pipeline event ordering contract is explicit.
23. Migration idempotency is documented or enforced via transaction.
24. Nested transaction deadlock is documented and detected at runtime.
25. `TransactionOptions` with `timeout` is declared in `.d.ts`.
26. Public API methods reject invalid argument types with clear `ValidationError`. Collection names are sanitized against path traversal.
27. Type declarations are validated against runtime via `tsd` or equivalent.
28. Linting, formatting, and import-cycle checks are wired into CI. Vitest coverage exclude path corrected.
29. Adapter/runtime guarantees are backed by targeted tests or explicitly narrowed documentation. MCP stdio and HTTP transports have basic test coverage. SQL adapter `writeAll()` uses native transactions.
30. All regression tests exist and pass.
31. The verification matrix passes.

---

## Out of Scope for alpha.3

The following are tracked in `design/alpha-4.md` or the pre-GA backlog:

| Item | Tracking |
|---|---|
| Decompose `Skalex` god object | alpha.4 #1 |
| Decompose `Collection` god object | alpha.4 #2 |
| Backpressure on watch event queues | alpha.4 #3 |
| `find()` pagination fast path | alpha.4 #4 |
| `structuredClone` optimization | alpha.4 #5 |
| `stats()` caching | alpha.4 #6 |
| `FsAdapter` lazy import for browsers | alpha.4 #7 |
| Skalex-Collection decoupling | alpha.4 #8 |
| `Symbol.toStringTag` / `Symbol.asyncDispose` | alpha.4 #9-#10 |
| `fetchWithRetry()` extraction | alpha.4 #12 |
| Async zlib in FsAdapter | alpha.4 #13 |
| Changelog retention / compaction | pre-GA |
| ANN vector indexing | pre-GA |
| `namespace()` capability checks | pre-GA |
| Transaction proxy hardening | pre-GA |

---

## Non-Goals

alpha.3 is not the release for:

- Architecture decomposition (that's alpha.4)
- New user-facing features
- Performance optimization beyond O(n^2) TTL fix
- ANN vector indexing
- WAL or multi-process support

---

## Execution Order

Recommended sequence:

**Phase 1 - P0 runtime safety:**
1. **#1** (_abortedIds pruning) - small, self-contained
2. **#2** (LLM provider throw) - trivial, one line
3. **#3** (D1 batch guard) - small, connector-only
4. **#4** (cap atomicity) - small, follows alpha.2 #11 pattern
5. **#5 + #6** (Memory fixes) - implement together

**Phase 2 - P1 DRY & architecture cleanup:**
6. **#7 + #8** (_meta + store dedup) - implement as a unit
7. **#9** (meta consolidation) - depends on #7
8. **#10 + #11** (shared ctx + remove database) - implement together
9. **#12** (soft-delete guard) - mechanical refactor
10. **#13** (constants) - mechanical find-replace
11. **#14** (namespace config) - small, isolated
12. **#15** (TTL O(n)) - small, isolated
13. **#16** (orphan cleanup) - small, isolated

**Phase 3 - P2 security, documentation & tooling:**
14. **#17-#24** (documentation batch) - all doc/JSDoc changes
15. **#25** (TransactionOptions type) - trivial
16. **#26** (input validation) - medium, touches many methods
17. **#27 + #28** (tsd + lint) - tooling setup
18. **#29** (adapter coverage) - test expansion
