# beta.1 Release Plan

**Status:** Pending alpha.6 completion
**Version:** v4.0.0-beta.1
**Prerequisite:** alpha.6 shipped.
**Gate:** beta.1 does not ship until every item passes regression tests and all existing tests remain green.
**Rule:** beta.1 introduces the production-grade reliability guarantees and the architectural completion items that alpha.6 could not ship without WAL and DataStore completion landing together. Each item must be fully tested and backwards-compatible.
**Theme:** Production-grade reliability (WAL, crash-safe transactions), DataStore abstraction completion, tx proxy hardening, explicit module dependencies.

Four items shipped ahead of beta.1 in alpha.6 (serialization correctness, bulk upsert pipeline, exact changelog restore, connector types entries). See `design/alpha-6.md` and CHANGELOG `[4.0.0-alpha.6]`.

---

## P0 - Reliability

### 1. Write-ahead log for crash-safe multi-collection transactions

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

## P1 - Architecture

### 2. Complete DataStore abstraction

**Issue:** None (alpha.4 #17 partial)
**Severity:** P1 - architecture
**Effort:** Large

**Problem:** alpha.4 introduced `InMemoryDataStore` as an internal seam for Collection's code, but persistence, transactions, and the TTL sweeper still read `col.data` / `col.index` directly. The abstraction covers ~30% of access points. A future disk-backed engine still requires rewriting `saveAtomic`, `loadAll`, `_applySnapshot`, and `sweep()`.

**Fix:** Route all remaining data access through the DataStore interface:
- `PersistenceManager.saveAtomic` / `save` / `loadAll` read via `store.getAll()` / `store.count()` instead of `col.data`.
- `Skalex._applySnapshot` uses `store.replaceAll(snap.data)` instead of direct assignment.
- `sweep()` receives the DataStore and mutates via `store.filter()` + `store.replaceAll()` instead of in-place array ops.
- The DataStore gains `serialize()` / `deserialize()` capability hooks so adapters can opt into their own serialization.

**Pairs with:** beta.1 #1 (WAL) - both touch the persistence paths.

**Scope:** `src/engine/persistence.js`, `src/engine/ttl.js`, `src/index.js`, `src/engine/datastore.js`.

**Test:** All existing tests pass with persistence/TTL/snapshot going through the DataStore. A stub DataStore that logs operations verifies every path is covered.

**Depends on:** alpha.4 #17 (initial DataStore introduction).

---

### 3. Per-module explicit dependencies

**Issue:** None (alpha.4 #14 completion)
**Severity:** P2 - architecture
**Effort:** Medium

**Problem:** Extracted alpha.4 modules pull dependencies from the `_ctx` object (`_ctx.fs`, `_ctx.embed`, `_ctx.logger`, etc.). Over time `_ctx` accumulates 18+ properties and becomes a god object of its own. Modules have no declared dependency surface.

**Fix:** Convert extracted modules to receive explicit dependencies in their constructor/function signature, not via `_ctx`. Pairs with formalizing `ICollectionContext` as a typed interface (alpha.4 #14).

**Scope:** `src/engine/exporter.js`, `src/engine/vector-search.js`, `src/engine/document-builder.js`, `src/engine/query-planner.js`, `src/engine/ai.js`, `src/engine/importer.js`, `src/engine/collection.js` (call sites).

**Test:** Each module has a standalone unit test that constructs it with minimal explicit dependencies (no `_ctx`).

**Depends on:** alpha.4 #14.

---

### 4. Tx proxy via AsyncLocalStorage (concurrent unawaited edge case)

**Issue:** None (documented in `weak-spots.md`)
**Severity:** P3 - correctness
**Effort:** Medium

**Problem:** Collection is a singleton per name. The tx proxy wraps method calls with a depth counter to distinguish tx-proxy writes from non-tx writes on the same instance. If a user does `const p = tx.insertOne(...); db.insertOne(...); await p;` (fire-and-forget), the counter is still elevated when the second call runs, bypassing the lock.

**Fix:** Replace the instance-level depth counter with `AsyncLocalStorage` to track tx identity per async context. Each async call chain carries its own tx state; concurrent chains don't interfere.

**Caveat:** `AsyncLocalStorage` is Node.js only. Requires a runtime shim for Bun / Deno / browser (Deno has it since 1.25; Bun since 0.6; browser needs a fallback).

**Scope:** `src/engine/transaction.js`, `src/engine/pipeline.js`.

**Test:** Regression test for the fire-and-forget pattern - non-tx write starts while tx write is in flight, lock blocks correctly.

**Depends on:** Confirmed cross-runtime AsyncLocalStorage availability.

---

## Regression Test Requirements

| Fix | Test scenario |
|-----|---------------|
| #1 (WAL) | WAL written before flush, deleted after; simulated crash mid-flush recovers to consistent state; adapter without WAL degrades gracefully |
| #2 (DataStore completion) | Persistence/TTL/snapshot go through DataStore; stub DataStore logs every access path |
| #3 (per-module dependencies) | Each extracted module instantiable with explicit deps; no `_ctx` references in module bodies |
| #4 (AsyncLocalStorage tx proxy) | Fire-and-forget `const p = tx.insertOne(...); db.insertOne(...); await p;` correctly blocks the non-tx write |

---

## Verification Matrix

beta.1 is not done when only the new tests pass. The release must also verify:

- `bun run test`
- `bun run smoke:node`
- `bun run smoke:bun`
- `bun run smoke:deno`
- `bun run smoke:browser`
- `bun run lint`
- `bun run deps:check`
- `bun run types:check`

---

## Success Criteria

beta.1 is done when:

1. Multi-collection transactions are crash-safe via WAL. A simulated crash mid-flush recovers to a consistent pre-transaction or fully-committed state on next `connect()`.
2. Persistence, TTL, and snapshot paths go through the `DataStore` abstraction. The initial `InMemoryDataStore` introduced in alpha.4 is no longer bypassed.
3. Extracted modules receive their dependencies explicitly instead of through the `_ctx` god object.
4. The tx proxy's concurrent fire-and-forget edge case is closed.
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
| Transaction proxy hardening beyond AsyncLocalStorage | beta |
| `dropCollection()` | beta feature backlog |
| `$exists`, `$set`, `$unset` operators | beta feature backlog |
| Cursor / iterator API for `find()` | beta feature backlog |
| Bulk delete by ID array | beta feature backlog |
| Connector subpath `require` / CJS bundles | later |

---

## Execution Order

1. **#1** (WAL) - crash-safe transactions, depends on alpha.4 #15 + #17.
2. **#2** (DataStore completion) - routes persistence through the abstraction; pairs with WAL.
3. **#3** (per-module explicit deps) - architecture completion, independent of WAL.
4. **#4** (AsyncLocalStorage tx proxy) - correctness cleanup, independent of WAL.
