# alpha.6 Release Plan

**Status:** Planned
**Version:** v4.0.0-alpha.6
**Prerequisite:** alpha.5 shipped.
**Gate:** alpha.6 does not ship until every item passes regression tests and all existing tests remain green.
**Rule:** alpha.6 is a correctness + packaging release. No breaking changes for the public API. On-disk persistence format changes but legacy payloads continue to load (auto-migrate on next save).
**Theme:** Close the correctness and packaging gaps surfaced for beta.1 that do not depend on WAL / DataStore completion, and ship them ahead of the reliability work so beta.1 can focus on crash safety.

---

## Scope

Four items carved out of `beta-1.md` - the subset that is decoupled from WAL and the DataStore completion and can ship independently. After alpha.6 lands, `beta-1.md` is purely about reliability (WAL, DataStore, tx proxy hardening, per-module deps). Severity categories below mirror the original beta-1.md structure so nothing is lost in the carve-out.

---

## P1 - Correctness

### 1. Out-of-band type metadata to eliminate `__skalex_bigint__` key collision (from beta-1.md #5)

**Severity:** P1 - correctness
**Effort:** Medium

**Problem:** The current persistence serializer encodes BigInt values as `{ __skalex_bigint__: "..." }` tagged objects embedded directly in the data, and Date values as `{ __skalex_date__: "..." }`. Any user document that legitimately stores an object with either key is silently revived as a BigInt or Date on load. Quiet data corruption vector.

**Fix:** Move type metadata out of the data and into a parallel wrapper:

```json
{ "data": { "n": "9007199254740993" }, "meta": { "types": { "bigint": [["n"]] } } }
```

- Encoder walks the value once, substitutes BigInt/Date values with their string form, and records each touched path under `meta.types`.
- Decoder detects the wrapper by the presence of both `data` and `meta.types` and reconstructs typed values from the path list.
- Legacy payloads (pre-alpha.6) continue to load via the existing inline-tag reviver. Any save after load rewrites the collection in the new format.

**Scope:**
- `src/index.js` - replace `_serialize` / `_deserialize` implementations.
- `tests/integration/serializer-out-of-band.test.js` - round-trip + legacy + collision + nested depth + auto-migration.
- `tests/integration/migrations-atomicity.test.js`, `tests/integration/collection-features.test.js` - update helpers that reach into the raw payload shape.

**Tests:**
1. BigInt round-trip.
2. Date round-trip.
3. Nested BigInt/Date at arbitrary depth.
4. Document with literal `__skalex_bigint__` key round-trips as a plain object.
5. Document with literal `__skalex_date__` key round-trips as a plain object.
6. Pre-alpha.6 (legacy inline-tag) payload loads correctly.
7. Re-saving a legacy payload migrates it to the new wrapped format.
8. `meta.types` omits type keys that have no matches.

**Depends on:** None.

---

### 2. Fix lossy changelog point-in-time restore (from beta-1.md #2)

**Severity:** P1 - correctness
**Effort:** Medium

**Problem:** `db.restore(collection, timestamp)` replays archived entries through `insertOne` / `updateOne`. Those paths run through `_buildDoc` / `applyUpdate` and regenerate `createdAt`, `updatedAt`, `_version`, `_expiresAt`, and `_vector` at restore time. Restored documents do not faithfully represent their archived state. This is the lossy behavior documented in alpha.5's llms.txt.

**Fix:** Add internal `Collection._rehydrateAll(docs)` and `Collection._rehydrateOne(id, archived)` helpers that write archived documents directly into the `DataStore` and indexes, bypassing the mutation pipeline entirely. `ChangeLog.restore()` calls them.

- Restore bypasses plugins, events, changelog (via `_restoring`), validation, schema checks, and FIFO cap enforcement, because archived state was already valid when captured.
- `createdAt`, `updatedAt`, `_version`, `_expiresAt`, and `_vector` are preserved verbatim.

**Scope:**
- `src/engine/collection.js` - add `_rehydrateAll` / `_rehydrateOne`.
- `src/features/changelog.js` - `restore()` uses the new helpers.
- `tests/integration/changelog-exact-restore.test.js` - regression coverage.

**Tests:**
1. Single-document restore preserves archived `createdAt` and `updatedAt`.
2. Single-document restore preserves archived `_version`.
3. Single-document restore preserves archived `_expiresAt`.
4. Single-document restore preserves archived `_vector`.
5. Full-collection restore preserves every document's system fields.
6. Restoring a DELETE entry removes the document without state regeneration.

**Depends on:** alpha.4 Collection decomposition. Does NOT depend on the DataStore completion that beta-1.md #2 proposes - the alpha.4 `InMemoryDataStore` surface is sufficient.

---

## P1 - Performance Optimization

### 3. Batch pipeline for `upsertMany` (from beta-1.md #1)

**Severity:** P1 - performance
**Effort:** Medium

**Problem:** `collection.upsertMany(...)` loops over documents and calls `upsert()` per item. Each iteration goes through the full `MutationPipeline.execute()` - `ensureConnected`, lock check, `_txSnapshotIfNeeded`, `assertTxAlive`, `markDirty`, `_saveIfNeeded`, session stats, changelog, events, plugin hooks. Most of this overhead is amortizable across the batch.

**Fix:** Add `MutationPipeline.executeBatch(...)` that runs the amortizable steps once per batch, and refactor `upsertMany` to use it.

- `ensureConnected`, lock check, `_txSnapshotIfNeeded`, eager `assertTxAlive`, `markDirty`, `_saveIfNeeded`, and session-stats increment all run once per batch.
- Changelog entries and watch events are still per-document, with per-doc op strings so a mixed-batch insert+update batch records each document with the correct `op`.
- Per-document `beforeInsert` / `afterInsert` / `beforeUpdate` / `afterUpdate` plugin hooks are preserved. `beforeInsert`/`beforeUpdate` fire inside the `mutateBatch` closure before the in-memory state change; `afterInsert`/`afterUpdate` fire after `executeBatch` returns.

**Scope:**
- `src/engine/pipeline.js` - new `executeBatch()` method.
- `src/engine/collection.js` - `upsertMany` routes through `executeBatch`.
- `tests/integration/upsert-many-batch.test.js` - regression coverage.

**Tests:**
1. Per-doc plugin hooks fire once per matching document with op-correct payloads on mixed batches.
2. Per-doc watch events emit with correct `op` (insert vs update) for mixed batches.
3. Per-doc changelog entries record the actual operation per document.
4. `autoSave` triggers one adapter write for the whole batch (not one per document).
5. `sessionStats.recordWrite` runs once per batch.
6. Transaction rollback reverts the entire batch atomically.
7. Mixed insert + update batch returns docs in input order.
8. Empty input is a no-op (no hooks, no save, no events).

**Depends on:** None. Builds on the alpha.4 Collection decomposition that already exists.

---

## P2 - Package Distribution

### 4. Normalize connector subpath exports - `types` entries (from beta-1.md #3, partial)

**Severity:** P2 - packaging
**Effort:** Small

**Problem:** `package.json` `exports` declares `import` for each `skalex/connectors/*` subpath but no `types` entry. TypeScript consumers importing from subpaths fall through to the root `.d.ts`, which works for aggregated barrels but not for the per-connector single-default subpaths (`./connectors/fs`, `./connectors/d1`, etc.).

**Fix:** Add a `.d.ts` file adjacent to every connector subpath and wire it into `exports`. Each `.d.ts` re-exports the relevant class from the root types so the single-source-of-truth stays `src/index.d.ts`.

**Partial carve-out:** the original beta-1.md #3 proposed `types` + `require` entries. alpha.6 ships `types` only. `require` (CJS bundles per connector) would add 10+ rollup outputs and is out of proportion for this release's scope; it stays tracked on the roadmap's DX & tooling list for a later release.

**Scope:**
- `src/connectors/index.d.ts`, `src/connectors/storage/index.d.ts`, `src/connectors/embedding/index.d.ts`, `src/connectors/llm/index.d.ts` - aggregate barrels.
- `src/connectors/storage/{fs,encrypted,local,d1,bun-sqlite,libsql}.d.ts` - per-connector single-default.
- `package.json` - `types` entry on every `./connectors/*` subpath.
- `tests/types/connectors.test-d.ts` - tsd coverage asserting each subpath resolves to the expected class.

**Tests:**
1. `tsd` resolves every subpath's default / named exports.
2. Each concrete adapter class assignable to `StorageAdapter` / `EmbeddingAdapter` / `LLMAdapter`.

**Depends on:** None.

---

## Regression Test Requirements

| Fix | Test scenario |
|-----|---------------|
| #1 (BigInt/Date out-of-band) | Round-trip BigInt/Date; backwards compat; auto-migration; literal `__skalex_bigint__` / `__skalex_date__` keys not misinterpreted |
| #2 (changelog restore) | Restore preserves exact `createdAt`, `updatedAt`, `_version`, `_expiresAt`, `_vector` from archived state |
| #3 (upsertMany batch) | 1000-doc upsert: hooks fire per-doc, changelog per-doc, events per-doc, tx rollback reverts all, single save + single stats increment |
| #4 (connector exports) | tsd resolves for each connector subpath; concrete adapters assignable to their base classes |

---

## Verification Matrix

alpha.6 is not done when only the new tests pass. The release must also verify:

- `bun run test`
- `bun run build`
- `bun run lint`
- `bun run deps:check`
- `bun run types:check`
- `bun run smoke:node`
- `bun run smoke:bun`
- `bun run smoke:deno`
- `bun run smoke:browser`

All five gate commands pass with zero errors. All four smoke runtimes pass.

---

## Success Criteria

alpha.6 is done when:

1. Persisted payloads use the out-of-band `{ data, meta: { types } }` wrapper. Legacy inline-tag payloads still load and auto-migrate on next save. A document with a literal `__skalex_bigint__` or `__skalex_date__` key round-trips as a plain object.
2. `db.restore(...)` rehydrates archived documents exactly - `createdAt`, `updatedAt`, `_version`, `_expiresAt`, `_vector` all preserved.
3. `upsertMany` runs through a single pipeline pass. Per-document hooks, events, and changelog entries are preserved with op-correct payloads. `autoSave` triggers one adapter write per batch, session stats record one write per batch.
4. Every `skalex/connectors/*` subpath has a matching `.d.ts` entry in `exports`. tsd coverage asserts each subpath resolves.
5. All existing tests pass unchanged. All new regression tests pass.
6. The verification matrix passes.

---

## Out of Scope for alpha.6

| Item | Tracking |
|---|---|
| WAL for crash-safe multi-collection transactions | beta.1 |
| DataStore completion (persistence / TTL / snapshot routing) | beta.1 |
| Per-module explicit dependencies (alpha.4 #14 completion) | beta.1 |
| AsyncLocalStorage tx proxy (fire-and-forget edge case) | beta.1 |
| Connector subpath `require` / CJS bundles | later |

---

## Execution Order

Each item is independent - any order works. Recommended (smallest-risk first):

1. **#4** connector `types` entries - packaging only, no runtime change.
2. **#1** out-of-band type metadata - persistence format change, legacy compat.
3. **#3** upsertMany batch pipeline - collection-level refactor.
4. **#2** exact changelog restore - depends only on alpha.4 Collection surface.
