# Skalex v4 Release Plan

The path from alpha.6 to the 4.0.0 stable release. This document is the public source of truth for release scope across the v4 cycle.

## Release scope

- alpha.7 - DRY cleanup
- alpha.8 - Persistence foundation
- alpha.9 - Correctness and security
- alpha.10 - Final public API surface
- beta.1 - Storage engine
- beta.2 - Transactions
- beta.3 - Performance and polish
- rc.1 - Documentation and verification
- 4.0.0 - stable release

## 1. Invariants

These hold for every release on the path to 4.0.0.

1. **Every release is safer than the last.** No test-count regressions, no new skipped tests. P0 findings against shipped versions trigger out-of-band patch releases per section 1.5.
2. **Zero runtime dependencies.** Every feature is reachable with `node:*` builtins and `fetch`.
3. **Isomorphic.** Every release passes the Node, Bun, Deno, and browser smoke suites. One runtime red blocks the release.
4. **Breaking changes live in alpha and early beta.** alpha.10 is the last window for breaking public API changes. beta.1 is the last window for breaking on-disk format changes. After beta.2 the release is additive-only.
5. **Every release ships a `MIGRATION.md` section**, even a pure refactor.
6. **Docs and code move together.** A behavior change without matching JSDoc, `.d.ts`, `ARCHITECTURE.md`, and `README.md` updates is incomplete.

---

## 1.5 Critical-issue lane

P0 findings preempt the release train. They do not wait for the next planned release. A P0 is one of:

- **A correctness defect** - data loss, silent behaviour regression, broken invariant, or a violation of a documented contract.
- **A security vulnerability** - any path that lets untrusted input compromise confidentiality, integrity, or availability.

What this looks like in practice:

- A P0 confirmed against the most-recently-shipped version triggers a patch release on that version (e.g. `4.0.0-alpha.6.1`, `4.0.0-rc.1.1`, or `4.0.1` once the stable release has shipped), not a fold-in to the next planned release.
- The patch release ships out-of-band, in parallel with whatever in-flight planned release is open. The planned release is not delayed to absorb the fix.
- The patch release carries only the P0 fix and its regression test - no scope creep, no opportunistic refactors.
- If the next planned release inherits the P0 fix, it cherry-picks from the patch release rather than re-implementing.
- A P0 found during an in-flight release blocks that release until fixed; the verification matrix would fail anyway.

What does NOT preempt the train:

- P1, P2, and P3 findings queue against the next planned release whose scope fits, or against 4.1 when no fit exists.
- Performance regressions short of correctness failure wait for the beta.3 hot-path benchmark gate.
- Architecture opinions are not findings; they queue against the relevant design milestone.

The cutting order in section 7 does NOT apply to P0 fixes. Section 7 is for scope pressure on planned releases, not for triaging confirmed defects.

---

## 2. Release train

```
alpha.7 → alpha.8 → alpha.9 → alpha.10   │   beta.1 → beta.2 → beta.3   │   rc.1 → 4.0.0
         breaking-change window          │   storage / tx / polish      │   src/* freeze / stable
```

| Release | Theme | Breaking? | Effort |
|---|---|---|---|
| alpha.7 | DRY cleanup | No | Small |
| alpha.8 | Persistence foundation: split collection store, versioned format, extract serializer | Internal only | Medium |
| alpha.9 | Correctness and security: MCP sanitization, `applyUpdate` strictness, AI move, query cache migration, error catalogue, MCP recall tools | Yes (narrow) | Medium |
| alpha.10 | Final API surface: type-precision audit, `UpdateDescriptor<T>` fix, `findOne` types, deprecated removal, uniform return meta, MCP write contract freeze, `createCollection` + `db.ask` strictness, by-ID helpers, `hasCollection`, inline migrations, `MemoryAdapter` export, `db.config()` readback, package hygiene | Yes (last window) | Medium-Large |
| beta.1 | Storage engine: hybrid `DataStore` + `PersistenceBoundary`, WAL, unified save strategy, opt-in `durable: true` fsync, capability-getter migration | On-disk format v3 | Large |
| beta.2 | Transactions: per-tx `Collection` wrappers, isolation rename, atomic rollback, `AbortSignal` | Tx callback signature | Medium |
| beta.3 | Performance and polish: delete-path index usage, filter cache, operator-only update fast path, events-async, changelog retention, feature-context refactor, stream iterator, `exists`/`has` shortcuts | No | Medium |
| rc.1 | Documentation, ADRs, migration guide, verification scripts | No | Small (no `src/*.js` changes) |
| 4.0.0 | Stable release | No | - |

---

## 3. Dependency graph

```
alpha.7 (DRY)
   │
   ▼
alpha.8 (store split + format v2 + serializer extract)
   │
   ├──▶ alpha.9 (AI move uses new _querycache collection)
   │          │
   │          ▼
   │      alpha.10 (error catalogue typed; deprecated removed)
   │          │
   │          ▼
   └────▶ beta.1 (hybrid DataStore + WAL + format v3)
                    │
                    ▼
                beta.2 (per-tx Collection wrappers on top of beta.1 call-path shape)
                    │
                    ▼
                beta.3 (additive, fully independent)
                    │
                    ▼
                rc.1 (docs + verification scripts)
                    │
                    ▼
                4.0.0
```

Critical precedence:

- `beta.1` hybrid DataStore depends on `alpha.8` store split (stable store shape needed).
- `beta.1` format v3 depends on `alpha.8` versioned format v2 (versioning mechanism must exist).
- `beta.2` per-tx wrapper redesign depends on `beta.1` DataStore (call-path shape stabilizes).
- `beta.2` atomic rollback depends on `beta.1` WAL.
- `alpha.10` `Collection<T>` type-precision audit depends on `alpha.9` AI move (import paths change before types solidify).

Nothing in the release train depends on `beta.3`. rc.1 branches off `beta.3` cleanly because `beta.3` is additive-only.

---

## 4. Risk register

| Risk | Owning release | Mitigation |
|---|---|---|
| Store-split regressions drift sub-records | alpha.8 | Field-count assertion per sub-record. CI fails if a new field lands in one without its sibling. |
| On-disk format lock-in | alpha.8 | Fixture file per format version (`tests/fixtures/format-v1.dat`, `v2`, `v3`). Loader tests round-trip each. |
| `applyUpdate` strictness breaks users relying on lenient behavior | alpha.9 | One release of warning mode before throwing. `MIGRATION.md` documents the migration path. |
| Bulk-insert stack overflow in `InMemoryDataStore.push(...arr)` (reproduced on Node 24 at 70K+ docs) | alpha.9 | alpha.9 item #13 replaces the spread with a for-loop; regression test at 100K / 500K pins the fix. Must land before alpha.10 freezes the API surface so input-size expectations stay truthful. |
| Type-precision gaps surface beyond `UpdateDescriptor<T>` | alpha.10 | Walk every public method with `tsd`; fixes land in alpha.10 if narrow, defer to 4.1 with a tracked issue otherwise. |
| Hybrid DataStore regresses hot-path perf | beta.1 | Publish `insertOne` / `find` / `search` p50/p95/p99 from alpha.6 as a baseline. Gate beta.1 on `p95 ≤ alpha.6 × 1.05`. |
| WAL corruption under crash | beta.1 | Randomized crash fault injection, 1000 runs minimum. Invariant: post-recovery state equals last successfully committed state. |
| Per-tx wrapper drift (wrapper lifetime vs tx lifetime) | beta.2 | Tests cover: wrapper captured outside `fn` throws `ERR_SKALEX_TX_STALE_PROXY`; wrapper state does not bleed between transactions; bare `Collection` never participates in tx dispatch. Identical transaction suite runs on Node, Bun, Deno, and browser. |
| Rollback fails mid-sweep | beta.2 | `Promise.allSettled` per collection; typed `ERR_SKALEX_TX_ROLLBACK_PARTIAL` with `details.failed`. Fault-injection test required. |
| Hot-path perf regression slips into beta.3 | beta.3 | Benchmark gate in CI; regression ≥ 5% fails the release. |
| Delete-path benchmark regression remains after beta.3 | beta.3 | Gate beta.3 on `deleteOne({ _id })` being ≥100× faster than alpha.6 baseline on a 100K-doc collection. |
| RC cycle too short | rc.1 | Tag 4.0.0 only when no open P0 issues exist and the maintainer is satisfied with rc.1 field exposure. No fixed soak length. Extend exposure on any P0 finding. |

---

## 5. Verification gates

Every release passes these before tagging:

```
bun run test
bun run build
bun run lint
bun run deps:check
bun run types:check
bun run smoke:node
bun run smoke:bun
bun run smoke:deno
bun run smoke:browser
```

Additional gates by release:

| Release | Extra gate |
|---|---|
| alpha.8 | Format fixture round-trip tests pass for v1 and v2 |
| alpha.10 | `tsd` positive and negative cases green; `api-surface.md` snapshot committed |
| beta.1 | 1000-run crash fault injection passes; hot-path benchmark within 1.05× alpha.6 |
| beta.2 | Fire-and-forget + nested async tx tests green on every runtime (including browser) |
| beta.3 | Hot-path benchmark no worse than beta.1; `deleteOne({ _id })` ≥100× faster than alpha.6 |
| rc.1 | Zero code changes vs beta.3 in `src/*.js`; docs coverage is 100% on the public surface |

---

## 6. Scope boundary

**In v4.0:** everything in the release train above. This includes the DataStore boundary, store split, transaction isolation with per-tx `Collection` wrappers, the full typed-error catalogue, `Collection<T>` generics refinement, MCP document sanitization, MCP write-contract freeze, WAL, unified save strategy, changelog retention, filter compilation cache, and operator-only update fast path.

**Deferred to 4.1:**

- Vector side-store and quantization
- Range / B-tree index for `$gt` / `$lt`
- Network adapter
- Schema DSL helper
- Tokenizer hook for Memory (extended to also accept a summarizer hook)
- ANN plugin surface
- Collection internal split (extract watch, rehydrate, cap enforcement, and read/query modules)
- Agent-memory cluster:
  - Decay and importance scoring (query-time only, no hot-path cost when unused)
  - First-class memory primitives (`collection.remember`, `collection.recall`)
  - Hybrid retrieval engine (vector + keyword + filter + recency + importance, single scored call)
  - Session scope helper (`db.scope({ userId, sessionId })`)

**Deferred to 4.2:**

- Partial-prefix compound-index matching
- ANN plugin surface refinement
- Legacy format v1 removed
- Additional adapters as warranted

**Deferred to v5:**

- Nested transactions with savepoints
- Async-native disk-backed DataStore

The deferred list is firm. Scope creep into the 4.0 window is the single biggest risk to release readiness.

---

## 7. Cutting order if scope must shrink

When a release feels too large to land cleanly, remove items in this order (least painful first) rather than rushing or compressing the verification matrix:

1. `db.diagnostics()` → 4.1
2. FsAdapter lockfile → 4.1
3. Optional `{ meta: true }` return shape → 4.1
4. `AbortSignal` in transactions → 4.1
5. Post-restore audit trail → 4.1
6. Tokenizer hook stub → 4.1

Do NOT cut:

- Store split (alpha.8) - blocks DataStore
- Versioned on-disk format (alpha.8) - blocks future migrations
- Hybrid DataStore (beta.1) - blocks scalability story and hot-path performance charter
- WAL (beta.1) - blocks reliability claim
- Unified save strategy (beta.1) - blocks correct error reporting
- Isolation rename (beta.2) - doc/behavior divergence is a credibility issue
- Per-tx `Collection` wrappers (beta.2) - closes ambient-state fragility and preserves isomorphic semantics
- `UpdateDescriptor<T>` precision fix (alpha.10) - last chance to fix a type that silently lets bad updates compile
- MCP sanitization (alpha.9) - security hardening
- Package exports (alpha.10) - users following the `.d.ts` hit runtime errors today
- Delete-path perf (beta.3) - required to meet the fastest-in-category benchmark target

---

## 8. Pacing

Skalex releases ship on a quality-gated cadence, not a calendar one. There are no fixed delivery dates between alpha.6 and 4.0.0, no target date for any individual release, and no minimum or maximum gap between releases.

What this means in practice:

- **No release has a target date.** A release is done when its verification matrix passes and its `MIGRATION.md` section is merged. Until then it stays open with no schedule pressure.
- **No minimum soak periods on a calendar.** Stability gates are state-based ("no open P0 issues", "two consecutive clean CI runs", "satisfied with field exposure of the rc.1 build"), not date-based. A release that has been stable in the wild for two days under heavy real-world use is no less ready than one that has been stable for a month under light use.
- **Order is dictated by the dependency graph in section 3. Pace is dictated by readiness against the verification matrix.** Releases land when they meet their gates, not when a clock says they should.
- **Scope is the lever, not pace.** If a release feels too big to land in one pass, drop items in the cutting order in section 7 - never compress correctness or skip the verification matrix to ship faster.
- **Effort labels in per-release docs ("Trivial", "Small", "Medium", "Large") are sizings relative to each other.** They help order work within a release; they do not represent wall-clock estimates.

The only ordering that matters is the dependency graph in section 3.

---

## 9. Ownership and execution

- One person owns each release end-to-end. That person writes the release doc, lands the PRs, and tags the release.
- Every P0 item has a linked issue.
- PRs reference the release doc section they implement.
- A release is done when the verification matrix is green on a fresh checkout and the CHANGELOG and MIGRATION entries are merged.

---

## 10. Change control

Changes to this plan happen via PRs that modify this file and the relevant release doc. Any change that moves an item across the alpha/beta boundary, drops an item from 4.0, or adds an item to 4.0 requires:

- A paragraph in the PR explaining the trigger.
- An update to the Risk Register if a risk is materialising.
- A note in the affected release's CHANGELOG section once that release ships.
