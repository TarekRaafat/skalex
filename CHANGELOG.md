# Changelog

All notable changes to Skalex are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [4.0.0-alpha.3] - 2026-04-11

Runtime safety, adapter consistency, code quality, and platform hardening. No new user-facing features; the release tightens long-lived runtime behaviour, consolidates internal construction paths, adds guardrails around public API boundaries, and wires lint, static analysis, and type-declaration validation into CI.

### Breaking Changes

- **`Memory.tokenCount()` and `Memory.context()` are now async** - both methods now read through the public Collection `find()` API so soft-delete, auto-connect, and future access hooks are honoured. Calls must be `await`ed:
  ```js
  const { tokens, count } = await mem.tokenCount();
  const ctx = await mem.context({ tokens: 4000 });
  ```
  Pre-`connect()` calls now trigger auto-connect instead of silently returning empty results.
- **`Migration.up()` receives the Skalex proxy, not a raw Collection** - the signature changed from `up(collection)` to `up(db)`.

  Before:
  ```js
  db.addMigration({ version: 1, up: async (col) => { /* ... */ } });
  ```
  After:
  ```js
  db.addMigration({ version: 1, up: async (db) => {
    const users = db.useCollection("users");
    // ...
  }});
  ```

  **Why this change.** The old `col` parameter was always `db.useCollection("_migration_<version>")` - an internal scratch collection named after the migration's version. It wasn't a general-purpose handle to the data being migrated; real migrations ignored it and reached for actual collections via closure (`db.useCollection("users")` from the enclosing scope). The parameter was a vestige.

  Wrapping each migration in a transaction (so partial state rolls back on failure - see the *Fixed* section) requires a *transactional* handle to whatever collections the migration touches. That handle is the Skalex instance inside the transaction, because Skalex's transaction proxy brands collections returned by `tx.useCollection(name)` as participating in the active transaction. Passing a single pre-obtained collection can't give a migration access to *other* collections transactionally.

  Switching the callback argument from the unused `col` to the actually-useful `db` proxy:
  - removes a parameter nobody was using productively,
  - gives migrations a transactional handle consistent with `db.transaction(fn)` callbacks,
  - lets migrations call `db.useCollection(name)` for any collection they need, all inside the same rollback-safe scope.

  The migration required to update existing callbacks is mechanical: replace `async (col) =>` with `async (db) =>` and call `db.useCollection("<name>")` for whatever the migration was actually working against.
- **`createLLMAdapter()` throws `AdapterError` on unknown provider** - previously returned `null` silently when the provider string did not match any known adapter, which meant a typo like `"opanai"` disabled `db.ask()` without warning. Now matches `createEmbeddingAdapter()` and throws `AdapterError` with `ERR_SKALEX_ADAPTER_UNKNOWN_PROVIDER`. Passing `{ provider: "openai" }` without a `model` still returns `null` (unchanged).
- **Public API methods reject invalid argument types** - `insertOne`, `insertMany`, `updateOne`, `updateMany`, `upsert`, `upsertMany`, `deleteOne`, `deleteMany`, `restore`, `find`, `findOne`, and `search` now throw `ValidationError` with `ERR_SKALEX_VALIDATION_ARG` when given `null`, primitives, arrays (where an object is expected), or non-object/non-function filters. Previously these failed deep inside with unclear stack traces.
- **Collection and memory session names are validated against path traversal** - `useCollection()` and `createCollection()` reject names containing `/`, `\`, `..`, `\x00`, or any character outside `[a-zA-Z0-9_.:-]`. Valid names must be 1-64 characters and start with a letter, digit, or underscore. Internal collections (`_meta`, `_changelog`, `_memory_*`) pass this check. `db.useMemory(sessionId)` applies the same validation to the session ID directly (1-56 characters, leaving room for the `_memory_` prefix inside the 64-char collection budget) and throws `ValidationError` / `ERR_SKALEX_VALIDATION_SESSION_ID` with a clear message at construction time, so an invalid session surfaces at `useMemory()` instead of at the first Memory operation.
- **`applyUpdate()` silently skips `updatedAt`** - user-provided `updatedAt` values in an update descriptor are discarded. This field is system-managed and is always set to the current time on every successful update, matching how `_id` and `createdAt` were already treated.
- **Nested transactions throw immediately** - calling `db.transaction()` inside another `db.transaction()` callback previously deadlocked. It now throws `TransactionError` with `ERR_SKALEX_TX_NESTED`.
- **`$regex` string length and ReDoS checks apply in `matchesFilter()`** - the length cap (default 500) and nested-quantifier rejection that alpha.2 applied only to LLM-generated filters in `ask()` now apply to every `$regex` string value passed to `find()`, `findOne`, etc. Pre-compiled `RegExp` instances bypass the cap and are considered trusted.
- **`Collection.database` property removed** - the back-reference to the owning Skalex instance is gone. Collection instances carry a shared `_ctx` instead. Code that walked `col.database` to reach the Skalex proxy must hold a direct reference to the `db` instead.
- **After-hook errors no longer abort transactions by default** - deferred side effects (after-insert / after-update / after-delete hooks, watch callbacks, changelog entries) run post-commit. In alpha.2.x an error thrown from any of them surfaced to the caller and could mask the fact that the transaction had already committed. The new default (`deferredEffectErrors: "warn"`) logs the error and returns the successful commit result. Callers that want the old behaviour must opt in with `new Skalex({ deferredEffectErrors: "throw" })` or pass `{ deferredEffectErrors: "throw" }` to individual `db.transaction(fn, opts)` calls; the "throw" strategy surfaces an `AggregateError` after the commit has landed.
- **MCP agent filters strip `$fn` and cap at depth 16** - filters coming through MCP tool handlers are sanitised before reaching the Collection API. Any `$fn` predicate (including nested inside `$or` / `$and` / `$not`) is removed and a warning logged. Filters nested deeper than 16 levels throw `ValidationError` / `ERR_SKALEX_VALIDATION_FILTER_DEPTH`. Agents that relied on function predicates through MCP must move the logic into explicit operators or the server-side plugin layer.

### Added

- **`deferredEffectErrors` config option** - configurable strategy for errors thrown by deferred side effects (watch callbacks, after-* plugin hooks, changelog entries) that run after a transaction commit. Accepts `"throw"` (aggregate into `AggregateError` after commit), `"warn"` (log and continue, default), or `"ignore"`. All effects run regardless of individual failures. Available as a constructor option and as a per-transaction override in `TransactionOptions`; per-transaction option takes precedence. Both paths share a single validator, so typos like `"warning"` are rejected with `ValidationError` / `ERR_SKALEX_VALIDATION_DEFERRED_EFFECT_ERRORS`.
- **`TransactionOptions` type declaration** - `{ timeout?: number, deferredEffectErrors?: "throw" | "warn" | "ignore" }`. TypeScript consumers can now pass `db.transaction(fn, { timeout: 5000 })` without a type error.
- **`D1Adapter.batchSize` option** - `writeAll()` chunks statements into configurable batches (default `1000`, matching Cloudflare D1's documented per-`batch()` limit) so large writes no longer fail unpredictably. Values outside `[1, 1000]` are rejected at construction. Cross-chunk atomicity is NOT guaranteed: a later chunk failing leaves earlier chunks committed.
- **`FsAdapter.cleanOrphans()`** - orphan temp-file cleanup moved from `PersistenceManager` onto the adapter that knows how to list files. `EncryptedAdapter` forwards the call. Browser/LocalStorage/SQL adapters are no-ops.
- **Shared `Ops` and `Hooks` constants** - `src/engine/constants.js` exports frozen maps for operation names (`insert`, `update`, `delete`, `restore`) and plugin hook names (`beforeInsert`, `afterInsert`, …). String literals in `collection.js` and `changelog.js` now reference these constants so typos become import errors instead of silent no-ops.
- **`sanitizeFilter()` in MCP tool handlers** - recursively strips `$fn` keys from AI-agent-supplied filters (including inside `$or`, `$and`, `$not` branches) before they reach the Collection API, preventing an AI-crafted filter from executing arbitrary JavaScript in the host process. A warning is logged per stripped `$fn`. The walker is also depth-bounded (max 16 levels) and throws `ValidationError` / `ERR_SKALEX_VALIDATION_FILTER_DEPTH` on overflow so an adversarial agent cannot blow the call stack with a deeply nested payload.
- **Per-instance transaction counter + pruning window** - `TransactionManager` carries its own `_idCounter` and `abortedIdWindow` (default 1000) instead of sharing a module-level counter across every Skalex instance in the process. Fixes a latent bug where two independent Skalex instances appeared to share transaction IDs and makes the abort-tracking window testable.
- **Error classes in `.d.ts`** - `SkalexError`, `ValidationError`, `UniqueConstraintError`, `TransactionError`, `PersistenceError`, `AdapterError`, and `QueryError` were runtime exports but were missing from `src/index.d.ts`. Now declared so TypeScript consumers can `instanceof`-check and read `.code` / `.details` without `@ts-expect-error`.
- **`tsd` type-declaration validation** - `tests/types/index.test-d.ts` exercises the full public surface (generics, connectors, plugins, watch, mcp, errors) via `expectType` / `expectAssignable`, run with `npm run types:check`. A deliberate mismatch now fails CI instead of silently drifting.
- **`eslint` + `madge` static analysis** - minimal flat-config eslint ruleset that catches genuine bugs (`no-undef`, `no-unused-vars`, `no-unreachable`) without enforcing formatting, plus `madge --circular` to block circular imports. Scripts: `npm run lint`, `npm run deps:check`, `npm run types:check`. `npm run test:all` runs all three plus tests and smoke.

### Fixed

- **Migration partial-state corruption + lost version bookkeeping** - migrations now run inside a transaction and record their applied version inside that same transaction via a new `recordApplied` callback that snapshots `_meta` into the touched set. `saveAtomic` then flushes the migration's data and the version record in a single `writeAll` batch. Previously, `MigrationEngine.run()` recorded `appliedVersions` in a post-loop `updateMeta()` call that only marked `_meta` dirty; if the process crashed before the next flush, the version record was lost and the migration re-ran on the next `connect()`. And a migration that mutated state and threw left partial mutations behind, forcing defensive idempotency. Now partial state rolls back automatically, the migration re-runs from a clean slate, and migrations that commit successfully are preserved even if a later migration fails. Performance: exactly one `saveAtomic` per migration. **Atomicity depends on the adapter's `writeAll` semantics**: fully atomic on `BunSQLiteAdapter`, `LibSQLAdapter`, and `D1Adapter` within a single chunk; narrowed on `FsAdapter` (renames are sequential and `_meta` is ordered last, so a crash mid-loop leaves a partial commit that the incomplete-flush sentinel detects on next `connect()`); not atomic across D1 chunks. `Skalex._recordAppliedVersions` throws `ERR_SKALEX_TX_INVALID_STATE` if ever called outside a transaction so the invariant cannot silently regress.
- **`_abortedIds` unbounded growth** - `TransactionManager` recorded every aborted transaction ID in a `Set` but never pruned it. A long-lived process with repeated timeouts leaked memory. Fixed by pruning IDs older than `counter - abortedIdWindow` on every transaction completion. Safe because transactions are serialised.
- **Capped collection eviction: atomicity + missing delete events** - `_enforceCapAfterInsert()` spliced evicted documents and removed them from indexes per-doc. If `_removeFromIndex()` threw mid-batch, some docs were removed from `_data` but remained in the field index. Fixed by collecting eviction candidates first and tracking each doc's explicit removal state (untouched / id-index-only / id-and-field-index) so a mid-batch failure restores exactly what was touched. FIFO-evicted documents now also emit a `delete` watch event so listeners see their disappearance alongside the corresponding insert.
- **`_meta` store shape drift** - `PersistenceManager._getOrCreateMeta()` and `PersistenceManager.loadAll()` both manually constructed `_meta` collection stores with the full 17-field shape, duplicating the definition in `CollectionRegistry.createStore()`. A new store field added to the registry would silently miss the meta path. All three construction paths (runtime create, load-from-disk, auto-create for `_meta`) now funnel through `registry.createStore()`.
- **Dual `_meta` ownership** - `Skalex._getMeta()` / `_saveMeta()` reached directly into `collections["_meta"].index`, while `PersistenceManager._getOrCreateMeta()` built it from scratch. Consolidated into `PersistenceManager.getMeta()` / `updateMeta()`. The Skalex class no longer accesses `collections["_meta"]` directly.
- **Per-collection context allocation** - every `Collection` instance received a freshly-built context object. Since the context uses lazy getters that defer to the database, the object is functionally identical across collections. Now built once per database and shared by reference.
- **`Collection.database` property removed** - the constructor exposed the full `Skalex` instance as `this.database`, breaking the encapsulation that `_ctx` was designed to provide. The class never used it internally. Now removed.
- **Soft-delete visibility check duplicated 7 times** - extracted to `Collection._isVisible(doc, includeDeleted)`. Behaviour is identical.
- **`namespace()` config drift** - child databases were built from 18 explicit field forwards. Any new config option silently broke inheritance. Now spreads the stored `_config` object so new options are inherited automatically.
- **TTL sweep O(n*k) splice loop** - `sweep()` iterated backward and called `data.splice(i, 1)` per expired doc. For `n` documents with `k` expired, this was O(n*k) due to array shifting. Replaced with a single-pass filter-and-reassign for linear time.
- **Schema drift under `onSchemaError: "warn"`** - warning messages now include the document `_id` and the specific validation errors so drift is auditable. JSDoc clarifies that `"warn"` mode does NOT prevent invalid data from being persisted.
- **Vitest coverage exclude path** - `vitest.config.js` excluded `src/adapters/storage/d1.js` but the directory is `src/connectors/`. The exclude silently matched nothing. Corrected to `src/connectors/storage/d1.js`.
- **`D1Adapter` / `Memory.compress()` / MCP tool collection validation now throw typed errors** - previously raised bare `Error` / `TypeError`. `D1Adapter` constructor throws `AdapterError` with codes `ERR_SKALEX_ADAPTER_D1_BINDING_REQUIRED`, `ERR_SKALEX_ADAPTER_D1_INVALID_TABLE`, `ERR_SKALEX_ADAPTER_D1_INVALID_BATCH_SIZE`. `Memory.compress()` throws `AdapterError` with `ERR_SKALEX_ADAPTER_LLM_REQUIRED` when no language model adapter is configured. `_validateCollection()` in the MCP tool handlers throws `ValidationError` with `ERR_SKALEX_VALIDATION_MCP_COLLECTION` for agent-supplied collection names that fail validation. Matches the `EncryptedAdapter` pattern and lets consumers `instanceof`-check / match on stable codes.
- **Version drift across docs, CDN examples, and the MCP `SERVER_INFO` block** - README, `llms.txt`, `docs/installation.md`, `docs/index.md`, `docs/index.html` (including the `softwareVersion` schema.org metadata), `docs/documentation.md`, `docs/usage-examples.md`, `src/connectors/storage/index.js`, `src/connectors/storage/browser.js`, and `src/connectors/mcp/index.js` all pinned or described stale pre-alpha.3 versions (ranging from `4.0.0-alpha.1` through `4.0.0-alpha.2.1`). All thirteen references are now on `4.0.0-alpha.3`. `docs/documentation.md` and `docs/usage-examples.md` also showed the pre-alpha.3 `up: async (col) => ...` migration signature in examples; both examples now use `up: async (db) => { const col = db.useCollection("users"); ... }` so a reader copying them will not break. A regression test now asserts `serverInfo.version === "4.0.0-alpha.3"` on the MCP `initialize` response so a forgotten version bump during a future release surfaces as a test failure.
- **Stale `docs/lib/skalex.browser.js`** - the docs-site playground bundle was a manual copy from alpha.1 and had drifted across three releases. Refreshed from the alpha.3 `dist/skalex.browser.js`.
- **`ARCHITECTURE.md` drift** - the internal contributor reference described the "alpha.2 design" and had three stale references: the Migration Engine section still used the old `_getMeta` / `up(collection)` / `_saveMeta` flow, the `collection.search()` step referenced `this.database.embed()` (the removed `Collection.database` property), and the engine directory listing + module-responsibility table omitted `src/engine/constants.js`. All four updated for alpha.3.
- **`examples/ai-chat-memory/index.js` missing awaits** - three `memory.context(...)` / `memory.tokenCount()` calls were not awaited after the async breaking change. The example would have run without throwing but printed Promise objects instead of strings. Fixed.
- **`findOne()` / `findOne(null)` / `findOne(undefined)` crash (pre-existing)** - `_findRaw` read `filter._id` without a nullish guard, so calling `findOne` with no argument (or an explicit `null` / `undefined`) threw `TypeError: Cannot read properties of undefined (reading '_id')` all the way back to alpha.1. The bug was surfaced during the alpha.3 audit pass that added argument-validation guards. A nullish filter now returns the first visible document, matching `find({})`'s "empty filter matches everything" semantics. Regression tests added.
- **`FsAdapter.cleanOrphans()`, `FsAdapter.writeAll()`, `EncryptedAdapter.writeAll()` / `cleanOrphans()`, `D1Adapter.writeAll()`, and `D1Adapter.batchSize` option** were runtime-exposed in alpha.3 but missing from `src/index.d.ts`. Added the missing declarations so TypeScript consumers can call them directly.
- **`Memory.compress({ keepRecent })`** - the `keepRecent` option was supported at runtime but not declared in the type. Fixed in `.d.ts`.

### Documented

- **Transaction isolation semantics** - JSDoc on `db.transaction()` now explicitly states that Skalex provides **read-committed**, not snapshot, isolation. Reads on collections that are not written to see the latest committed state, including external mutations. To get a stable view of a collection, write to it first to trigger a snapshot.
- **Transaction timeout semantics** - the timeout is cooperative, not preemptive. When it fires the outer promise rejects, but in-flight mutations continue until they next reach an `assertTxAlive()` check.
- **Nested transaction deadlock** - now detected at runtime and thrown instead of silently deadlocking.
- **`$fn` security surface** - JSDoc on `query.js` now states that `$fn` executes arbitrary JavaScript and must never be passed user-controlled or AI-generated functions. MCP-sourced filters are sanitized via the new `sanitizeFilter()` helper.
- **Pipeline event ordering contract** - JSDoc on `MutationPipeline.execute()` explicitly states that watch events are emitted before after-hooks run. Observers may see events for mutations whose after-hooks subsequently throw; event dispatch is synchronous and a slow listener blocks the mutation pipeline.
- **Migration idempotency guidance** - JSDoc on `MigrationEngine.add()` explains the transaction-scoped rollback guarantee and still recommends idempotent write patterns (`upsert`, check-before-mutate) so the narrowed `FsAdapter` failure window cannot produce surprises.

### Tests

New subject-oriented test files:

- `tests/unit/transaction.test.js` - `TransactionManager` unit coverage: bounded `_abortedIds` pruning, per-instance counter isolation, timeout, nested-transaction detection, and the `deferredEffectErrors` strategy (instance default + per-transaction override + validation).
- `tests/unit/d1-adapter.test.js` - `D1Adapter` chunking, batch-size bounds, and chunk-failure semantics.
- `tests/unit/adapters.test.js` - `createLLMAdapter` factory (unknown provider, backwards-compat).
- `tests/unit/constants.test.js` - `Ops` / `Hooks` frozen maps.
- `tests/integration/migrations-atomicity.test.js` - end-to-end migration atomicity: partial-state rollback, retry from clean state, atomic `_meta` bookkeeping, read-only migrations, and the `_recordAppliedVersions` active-tx invariant.
- `tests/integration/transaction-behavior.test.js` - observable transaction behaviour (read-committed isolation).
- `tests/types/index.test-d.ts` - tsd smoke tests for the full public type surface, including deliberate-breakage verification.

Tests added to existing subject files:

- `tests/integration/collection-features.test.js` - capped-collection FIFO eviction events, shared `_ctx`, `Collection.database` removal, `updatedAt` system-managed, `insertOne` / `find` argument validation, watch-before-after-hook ordering.
- `tests/integration/persistence-coherence.test.js` - `_meta` owned by `PersistenceManager`, `_meta` store shape, orphan cleanup delegation, `FsAdapter` rename failure + orphan recovery.
- `tests/integration/skalex-core.test.js` - `namespace()` config inheritance, `useCollection` name validation (accepts internal + unusual names, rejects traversal + control chars).
- `tests/unit/memory.test.js` - `tokenCount()` / `context()` async + auto-connect + soft-delete respect.
- `tests/unit/ttl.test.js` - linear-time sweep regression.
- `tests/unit/query.test.js` - `$regex` length cap, ReDoS rejection, pre-compiled RegExp bypass.
- `tests/unit/mcp.test.js` - `sanitizeFilter` (`$fn` strip + depth guard), `StdioTransport` (parse / buffer split / reassembly / PARSE_ERROR), `HttpTransport` (202, 413 oversized body, SSE endpoint + broadcast).

Total: **784 vitest tests** across 30 files. All four smoke runtimes green: **Node 79** (`node.test.cjs`), **Bun 54** (`bun.test.js` + `bun-sqlite.test.js`), **Deno 47** (`deno.test.js`), **browser 49** (`browser.test.js` ESM build + UMD build). `eslint`, `madge --circular`, and `tsd` all clean.

### Deferred to a later release

- **Prettier** - the only tooling item not in this release. Running `prettier --check` on the full tree would either generate a large formatting diff or require a carefully tuned config, both out of scope here. Will land in a dedicated formatting-only follow-up so the diff stays reviewable.

---

## [4.0.0-alpha.2.1] - 2026-04-10

Correctness-only patch for two P0 bugs that block the migration and connect-retry models.

### Fixed

- **Connect-time migration deadlock** - Migrations that called collection write APIs (`insertOne`, `updateOne`, etc.) during `db.connect()` would self-deadlock. The write call invoked `_ensureConnected()`, which returned the still-pending `_connectPromise`, waiting forever for the connect that was waiting for the migration. Fixed by introducing a `_bootstrapping` flag set after `loadData()` completes but before migrations run. `_ensureConnected()` returns immediately when the flag is true since the database is already loaded and the caller is inside the connect lifecycle.
- **Failed `connect()` not recoverable** - If `connect()` failed with a transient adapter or filesystem error, `_connectPromise` was never cleared. Subsequent `connect()` calls returned the same rejected promise forever, permanently bricking the instance. Fixed by clearing `_connectPromise` in a `.catch()` handler so retries work after the underlying error clears.

### Tests

- 3 new regression tests in `tests/integration/skalex.test.js`:
  - Migration with `insertOne` resolves and inserted document exists
  - Migration with `updateOne` resolves and updated document reflects new value
  - Failed `connect()` recovers when adapter is fixed and second `connect()` succeeds

---

## [4.0.0-alpha.2] - 2026-04-09

### Breaking Changes

- **Serializer: Date objects now persist as tagged objects** - `Date` values are encoded as `{ __skalex_date__: "ISO-8601" }` during persistence and revived as `Date` on load. Alpha.1 stored dates as raw JSON strings via `JSON.stringify` (which calls `.toJSON()` / `.toISOString()`), meaning they loaded back as plain strings, not `Date` instances. Databases written by alpha.1 that contain `Date` fields will continue to load the raw ISO string; a re-save will convert them to the new tagged format automatically.
- **Export: `inferSchema` is no longer exported from the root module** - the named export `inferSchema` has been removed. The function still exists internally in `src/engine/validator.js` but is no longer part of the public API surface. If you were importing it directly, use `parseSchema` with an explicit schema definition instead.
- **Error type: `restore()` throws `QueryError` instead of generic `Error`** - calling `restore()` on a collection without `softDelete: true` now throws a `QueryError` with code `ERR_SKALEX_QUERY_SOFT_DELETE_REQUIRED`. Code that catches `Error` broadly is unaffected; code that checks `error.constructor === Error` or `error.message` strings may need updating.
- **Mutation: `applyUpdate()` silently skips `_id` and `createdAt` fields** - update descriptors that include `_id` or `createdAt` keys no longer mutate those fields. This prevents accidental `_id` corruption and `createdAt` overwriting. If you relied on updating these fields via `updateOne` / `updateMany`, that path is now blocked.
- **Mutation: mixed operator and plain-key update objects are no longer supported** - in alpha.1, `{ $inc: 1, someField: "x" }` as an update value would attempt to apply `$inc` and also set `someField`. The current version treats any object containing `$`-prefixed keys as a pure operator descriptor and silently ignores non-`$` keys within it. Separate operator updates from plain field assignments into distinct update calls.

### Added

#### Engine Modularisation

The monolithic `index.js` (1,091 lines) has been decomposed into 6 focused engine modules. The public API is unchanged - this is a purely internal restructuring that improves maintainability, testability, and separation of concerns.

| Module | Responsibility |
|--------|----------------|
| `src/engine/errors.js` | Typed error hierarchy (`SkalexError`, `ValidationError`, `UniqueConstraintError`, `TransactionError`, `PersistenceError`, `AdapterError`, `QueryError`) with stable `ERR_SKALEX_*` codes and structured `details` objects for programmatic error handling |
| `src/engine/persistence.js` | Load/save orchestration, dirty tracking (`_dirty` flag per collection), write-queue coalescing (`isSaving` / `_pendingSave`), flush sentinel for crash detection, and orphan temp file cleanup on connect |
| `src/engine/pipeline.js` | DRY mutation lifecycle - every CRUD operation runs through `pipeline.execute()`: `ensureConnected → txSnapshot → beforePlugin → [mutation] → markDirty → save → changelog → stats → event → afterPlugin`. Includes stale continuation guard (`assertTxAlive`) |
| `src/engine/registry.js` | Collection store/instance management, lazy creation, metadata inspection (`inspect`, `dump`, `stats`, `schema`), and `rename` |
| `src/engine/transaction.js` | Serialised transaction execution via `_txLock` promise chain, lazy copy-on-first-write snapshots, configurable timeout with `Promise.race`, deferred side-effects, and stale continuation tracking via `_abortedIds` |
| `src/engine/adapters.js` | AI adapter factory functions (`createEmbeddingAdapter`, `createLLMAdapter`) extracted from `index.js` |

#### Typed Error Hierarchy

All engine throws now use typed errors with stable codes. Consumers can handle errors programmatically without parsing message strings:

```js
try {
  await col.insertOne(doc);
} catch (e) {
  if (e instanceof Skalex.UniqueConstraintError) { /* handle */ }
  if (e.code === "ERR_SKALEX_UNIQUE_VIOLATION") { /* also works */ }
}
```

Error classes are accessible as static properties on `Skalex` (CJS/UMD) and as named exports (ESM): `SkalexError`, `ValidationError`, `UniqueConstraintError`, `TransactionError`, `PersistenceError`, `AdapterError`, `QueryError`.

#### Lazy Copy-on-First-Write Transaction Snapshots

Transactions no longer deep-clone every collection at start. A collection is only snapshotted when it is first mutated inside the transaction. Cost is now O(touched collections) instead of O(total database size).

| Collections | Before (alpha.1) | After (alpha.2) | Improvement |
|---|---|---|---|
| 10 (touch 1) | 10 clones | 1 clone | 10x |
| 50 (touch 2) | 50 clones | 2 clones | 25x |
| 100 (touch 1) | 100 clones | 1 clone | 100x |

#### Transaction Timeout

Transactions accept an optional `timeout` (in milliseconds). If `fn()` does not resolve in time, the transaction is aborted, rolled back, and the lock is released so queued transactions can proceed:

```js
await db.transaction(async (tx) => {
  // ...
}, { timeout: 5000 });
```

Timed-out transactions throw `TransactionError` with code `ERR_SKALEX_TX_TIMEOUT`. Stale continuations from the aborted `fn()` are tracked via `_abortedIds` and rejected with `ERR_SKALEX_TX_ABORTED` if they attempt further mutations.

#### Stale Continuation Detection

After a transaction times out or aborts, any async code still running from the aborted `fn()` is prevented from mutating state. Each mutation calls `assertTxAlive()` before its first in-memory state change. Both the entry-time transaction ID and the collection's creation-time transaction ID are checked against `_abortedIds`.

#### Dirty Tracking

Collections now carry a `_dirty` flag set on every mutation and cleared after a successful write. `saveDirty()` only persists collections that actually changed, reducing I/O to be proportional to mutation rate rather than total database size.

#### Flush Sentinel (Crash Detection)

`saveAtomic()` (used by transaction commits) writes a sentinel to the `_meta` collection before the batch and clears it after. If the process crashes mid-batch, the sentinel survives on disk. On next `connect()`, `_detectIncompleteFlush()` checks for an uncleared sentinel and logs a warning identifying which collections may be inconsistent.

#### Batch Writes (`writeAll`)

A new `writeAll(entries)` method on `StorageAdapter` enables batch persistence using each adapter's native atomicity primitive:

| Adapter | Strategy |
|---------|----------|
| `FsAdapter` | Two-phase: write all temp files → rename sequentially. Best-effort cleanup on failure. |
| `BunSQLiteAdapter` | Single `db.transaction()` - true ACID via SQLite WAL |
| `D1Adapter` | `d1.batch()` - atomic per batch call |
| `LibSQLAdapter` | `client.batch(statements, "write")` - LibSQL transaction |
| `EncryptedAdapter` | Encrypts all entries in parallel, delegates to inner adapter's `writeAll()` |
| Base class (fallback) | Sequential `write()` calls - backward compatible for custom adapters |

#### Orphan Temp File Cleanup

On `connect()`, `FsAdapter` directories are scanned for leftover `.tmp.*` files from interrupted writes. Orphans are removed before any data is loaded.

#### Compound Indexes

Collections can now declare multi-field compound indexes for O(1) lookups on equality queries across multiple fields:

```js
db.createCollection("orders", {
  indexes: [["userId", "status"]],
});
// find({ userId: "abc", status: "active" }) uses compound index
```

#### Logical Query Operators

`$or`, `$and`, and `$not` are now supported in all query filters (`find`, `findOne`, `count`, `updateMany`, `deleteMany`):

```js
await col.find({ $or: [{ status: "active" }, { role: "admin" }] });
await col.find({ $not: { archived: true } });
await col.find({ $and: [{ age: { $gte: 18 } }, { age: { $lt: 65 } }] });
```

Malformed logical operators (e.g. `$or` with a non-array value) throw `QueryError`.

#### Schema Validation on Updates

Schema validation now runs on `updateOne` and `updateMany`, not just inserts. The three error modes (`throw`, `warn`, `strip`) apply consistently to both insert and update paths.

#### Mutation Pipeline

All 7 mutation methods (`insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `restore`) now delegate to `pipeline.execute()`. This eliminates ~200 lines of duplicated before/after hook, changelog, event emission, stats tracking, and save boilerplate that was previously repeated in every method.

### Fixed

#### Data Corruption Fixes (P0)

- **Fix stale Collection instances after `createCollection` + `connect`** ([#22](https://github.com/TarekRaafat/skalex/issues/22)) - `loadData()` now re-binds the `_store` reference on cached Collection instances after loading from disk. Previously, `createCollection()` before `connect()` cached an instance pointing to an empty store; after `connect()` replaced the store with loaded data, the cached instance still referenced the old empty store. Reads returned zero results and writes with `{ save: true }` overwrote disk data.
- **Fix upsert operator leak into inserted documents** ([#23](https://github.com/TarekRaafat/skalex/issues/23)) - `upsert()` now resolves query operator values to plain values before inserting. Previously, `upsert({ email: { $eq: "x" } }, doc)` on an empty collection stored `{ email: { $eq: "x" } }` as a literal field value, silently corrupting the document on disk.
- **Fix `insertMany()` unique index corruption on partial batch failure** - `insertMany()` now preflights all unique constraints before any index mutation via `assertUniqueBatch()`. Previously, if the second document in a batch violated a unique constraint, the first document was already in the unique index but not in `_data` or `_id` index, creating a ghost entry that permanently blocked future inserts with the same field value.
- **Fix non-transactional writes captured by active transaction rollback** - Transaction participation is now explicit via `_activeTxId` stamped by the proxy on Collection instances obtained through `tx.useCollection()`. Non-transactional writes to untouched collections during an active transaction are no longer snapshotted or rolled back.
- **Fix stale transaction proxy usable after commit/timeout** - The transaction proxy now checks ctx liveness on every property access. Using a captured proxy reference after the transaction has ended throws `TransactionError` with code `ERR_SKALEX_TX_STALE_PROXY`.
- **Fix `{ save: true }` resolving before persistence completes** - `_saveOne()` now accumulates waiting callers when a save is in-flight and resolves all of them only after the coalesced re-save actually completes. Previously, the second caller's `await` resolved immediately when `_pendingSave` was set, before data reached storage.

#### Persistence Coherence Fixes (P1)

- **Fix `saveAtomic()` memory/disk divergence** ([#6](https://github.com/TarekRaafat/skalex/issues/6)) - `_meta` (with flush sentinel) is now included in the single `writeAll()` batch instead of being written separately before and after. SQL adapters get native atomicity; FsAdapter gets a narrowed failure window. If the batch fails, the sentinel survives on disk for crash detection on next load.
- **Document `save()`/`saveDirty()` best-effort semantics** ([#12](https://github.com/TarekRaafat/skalex/issues/12)) - Multi-collection saves run each collection independently via `Promise.all`. If one write fails, others may have already committed. Atomic multi-collection writes are only guaranteed through `transaction()` which uses `saveAtomic()`.
- **Add database-level save mutex (`_saveLock`)** - All save paths (`save`, `saveDirty`, `saveAtomic`) now serialize through a promise-chain lock, preventing concurrent save and transaction commit from interleaving. Mirrors the existing `_txLock` pattern.
- **Make `FieldIndex.update()` atomic** - If re-indexing a document fails (e.g. unique constraint on a different field), the old document is restored in the index. Previously, `remove(old)` then `_indexDoc(new)` could leave the old document invisible to index-based queries if `_indexDoc` threw.
- **Fix `ChangeLog.restore()` not persisting restored state** - `restore()` now calls `saveData()` after both single-document and full-collection restore paths. Previously, restored state was only in-memory and would be lost on disconnect unless the caller explicitly saved.

#### Query/Index Correctness Fixes (P2)

- **Fix plain-object filter matching** - `matchesFilter()` now uses structural deep equality for plain object filter values (no `$` keys). Previously, `{ metadata: { a: 1 } }` as a filter vacuously matched every document because all operator checks (`$eq`, `$gt`, etc.) evaluated false without returning false. The fix detects operator objects by the presence of `$`-prefixed keys and routes non-operator objects through a zero-dependency `deepEqual()` implementation that handles plain objects, arrays, Date, RegExp, and nested structures.
- **Reject non-scalar values in compound index fields** - Compound indexes now validate field values at index time and throw `ValidationError` with code `ERR_SKALEX_VALIDATION_COMPOUND_INDEX` for objects, arrays, and Date values. Previously, `encodeTuple()` fell back to `String(v)` which collapsed all objects to `"[object Object]"`, causing distinct documents to collide in the compound index and producing false-positive lookups. Null and undefined remain allowed.

#### Correctness Hardening (P2.5)

- **Fix `ifNotExists` leaking raw mutable internal doc** - `insertOne()` with `ifNotExists` now returns a stripped shallow copy instead of the raw internal document reference.
- **Add `ensureConnected()` to aggregation methods** - `count()`, `sum()`, `avg()`, `groupBy()` now trigger auto-connect if called before `connect()`.
- **Reject dot-notation fields in index declarations** - `IndexEngine` constructor throws `ValidationError` with code `ERR_SKALEX_VALIDATION_INDEX_DOT_PATH` for fields containing `.`. The index engine uses direct property access, so dot-path fields silently produced false negatives.
- **Make `connect()` idempotent** - Concurrent `connect()` calls now return the same promise instead of triggering multiple loads.
- **Add TTL timer `.unref()`** - The periodic TTL sweep timer no longer prevents graceful process shutdown.
- **Strip `_vector` from explicit `select` projections** - `_projectDoc()` now excludes `_vector` even when the caller explicitly includes it in the `select` array.
- **Recursive dangerous-key stripping in `applyUpdate()`** - Nested `__proto__`, `constructor`, and `prototype` keys are now stripped recursively from update values before assignment, not just at the top level.
- **Re-export error types and Collection as named exports** - `SkalexError`, `ValidationError`, `UniqueConstraintError`, `TransactionError`, `PersistenceError`, `AdapterError`, `QueryError`, and `Collection` are now available as named ESM exports from `'skalex'`.
- **Short-circuit `stripVector` when no `_vector` present** - `stripVector()` now checks for `_vector` before creating a copy, reducing allocation overhead on non-embedded collections.
- **Fix `generateUniqueId` entropy truncation** - IDs now preserve the full random suffix instead of truncating from 27 to 24 characters, retaining all 12 bits of randomness that were previously discarded.
- **Extract `typeOf()` utility in validator** - The duplicated type-detection expression in `validateDoc` and `stripInvalidFields` now uses a shared `typeOf()` function.
- **Use `META_DOC_ID` constant for flush sentinel lookup** - `_detectIncompleteFlush` and `_getOrCreateMeta` now use a shared constant instead of hardcoded `"migrations"` strings.
- **Throw `PersistenceError` on corrupt collection files by default** - `loadAll()` now throws `PersistenceError` with code `ERR_SKALEX_PERSISTENCE_CORRUPT` when a collection file fails to deserialize. The previous silent-warning behavior is available via `{ lenientLoad: true }`.
- **Prevent user spread from overwriting system timestamps on insert** - `_buildDoc()` now sets `createdAt` and `updatedAt` after spreading user input, ensuring system timestamps are always current. User-provided `_id` is preserved via nullish coalescing.
- **`dump()` returns deep copies** - `dump()` now uses `structuredClone` instead of shallow array spread, preventing callers from corrupting internal state by mutating returned documents.
- **Document connector subpath exports as raw ESM** - connector subpaths (`skalex/connectors/*`) point to raw `src/` ESM source with `node:*` imports, not bundled `dist/` artifacts. This is intentional: connectors are runtime-specific and not candidates for browser stubbing. `src/connectors` is included in the published `files` list. Full `import`/`require`/`types` normalization is tracked for beta.1.
- **Export base adapter classes from connector barrels** - `StorageAdapter`, `EmbeddingAdapter`, and `LLMAdapter` are now exported from their respective barrel files and the full connectors barrel. Consumers can extend base classes without reaching into internal paths.
- **Add `src/engine/errors.js` to package `files`** - The encrypted adapter's transitive dependency on `errors.js` is now included in the published package.

### Tests

- **82 new tests** across 7 files, bringing the total from 571 to 653 (all passing)
- **New file: `data-integrity.test.js`** (16 tests) - regression tests for all P0 data corruption fixes: stale Collection instances, upsert operator leak, insertMany ghost index entries, transaction isolation, stale proxy detection, save durability, and changelog restore persistence
- **New file: `persistence-coherence.test.js`** (10 tests) - regression tests for P1 persistence fixes: index update atomicity, saveAtomic batch coherence, sentinel clear failure handling, save best-effort semantics, save mutex serialization, write coalescing, and concurrent saveDirty+saveAtomic
- **New file: `correctness-hardening.test.js`** (20 tests) - regression tests for P2.5 hardening: ifNotExists copy, aggregation auto-connect, dot-notation rejection, connect idempotency, vector select, dangerous key stripping, named exports, stripVector, ID entropy, corrupt load, system fields, dump deep copy
- **New file: `engine-overhaul.test.js`** (43 tests) - comprehensive regression suite: transaction timeout/abort/rollback, dirty tracking, flush sentinel detection, compound index candidate selection, logical operator edge cases, typed error structure, fault injection (adapter write failures, partial batch failures), stale continuation detection, collection instance poisoning recovery, `$inc`/`$push` operator correctness, update/delete rollback, and capped collection enforcement
- **Expanded: `collection-features.test.js`** (+11 tests) - schema enforcement on updates: validation rejection, strict mode, warn mode, `updateMany` batch validation
- **Expanded: `skalex.test.js`** (+11 tests) - `_id` field integrity/immutability, Date serialization round-trip
- **Expanded: `query.test.js`** (+17 tests) - logical operators: `$or`, `$and`, `$not`, nesting, error handling for malformed operators; plain-object structural equality: nested objects, arrays, Dates, empty objects
- **Expanded: `indexes.test.js`** (+13 tests) - compound index non-scalar rejection: objects, arrays, Dates, scalars allowed, null/undefined allowed, rejection on update/buildFromData paths
- **Expanded: `indexes.test.js`** (+6 tests) - compound index add/remove/lookup, type collision handling, `buildFromData` reset
- **Expanded: `changelog.test.js`** (+2 tests) - edge cases in changelog restore
- **Expanded: `skalex-core.test.js`** (+1 test) - additional core method coverage

### Design Documents

- `design/atomic-persistence.md` - detailed design for `writeAll` + flush sentinel, competitive analysis, edge case matrix, scalability analysis
- `design/transaction-lazy-snapshots.md` - detailed design for lazy snapshots + timeout, isolation semantics, post-timeout safety
- `design/ann-vector-index.md` - ANN vector index design (future)
- `design/reliability-audit.md` - full engine reliability audit for primary-database use cases
- `design/alpha1-vs-pipeline-comparison.md` - comprehensive diff analysis of alpha.1 vs pipeline changes

### Benchmarks

- `tests/benchmarks/engine.mjs` - performance benchmarks for engine operations

---

## [4.0.0-alpha.1] - 2026-04-01

### Fixed

- **Transaction: `autoSave` suppressed during `fn()`** - writes no longer flush to disk mid-transaction when `autoSave: true`; the adapter is only written once on commit. (#1)
- **Transaction: `structuredClone` replaces `JSON.parse/stringify` for snapshots** - Date, TypedArray, Map, Set, RegExp, and other non-JSON types now survive rollback correctly. (#2)
- **Transaction: `_inTransaction` flag** - added to the constructor and toggled around `fn()` so `_saveIfNeeded()` in collection operations correctly detects an active transaction. (#3)
- **Transaction: event emissions and plugin after-hooks deferred until commit** - `watch()` observers and `after*` plugin hooks no longer fire for writes that are subsequently rolled back; they are queued and flushed atomically on commit. (#4)
- **Transaction: concurrent transactions serialised via promise-chain mutex** - a `_txLock` chain ensures only one transaction runs at a time, eliminating lost-update races under `Promise.all`. (#7)
- **Transaction: `db.collections` blocked inside `fn()` via Proxy** - direct mutations to `db.collections` bypass the snapshot; accessing the property inside a transaction callback now throws a descriptive error directing callers to `db.useCollection()`. (#11)
- **Documentation: transaction guarantees corrected** - replaced "atomic" / "snapshot + commit/rollback" with accurate language across README, llms.txt, docs/index.md, and docs/index.html. (#15)
- **Serializer: BigInt-safe default serializer/deserializer** - the default `JSON.stringify`/`JSON.parse` pair is replaced with `_serialize`/`_deserialize`, which encode BigInt as tagged objects and revive them on load; custom serializer options are unaffected. (#16)
- **Transaction: commit sequence corrected** - `saveData()` now runs before the side-effect queue is flushed, so `watch()` callbacks and plugin hooks observe fully persisted state. The `_inTransaction` flag is cleared after `saveData()` and before the flush, so observers can safely trigger further operations without them being re-queued.
- **Transaction: `restore()` now uses transaction helpers** - `restore()` was calling `_changeLog.log()` and `_eventBus.emit()` directly, bypassing the transaction queue. It now uses `_logChange()` and `_emitEvent()` so events and changelog entries are properly deferred until commit.

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
- `dist/skalex.umd.min.js`: IIFE/UMD for CDN `<script>` usage (`window.Skalex`)
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
