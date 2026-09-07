# Skalex v4 Release Plan

The path from alpha.6 to the 4.0.0 stable release. This document is the public source of truth for release scope across the v4 cycle.

## Release scope

- alpha.7 - Correctness, reliability and DRY cleanup
- alpha.8 - Lifecycle and persistence foundation
- alpha.9 - Query contracts, security and transaction design validation
- alpha.10 - Freeze validated public contracts
- beta.1 - Storage engine
- beta.2 - Transactions
- beta.3 - Performance and polish
- rc.1 - Documentation and verification
- 4.0.0 - stable release

## 1. Invariants

These hold for every release on the path to 4.0.0.

1. **Every release is safer than the last.** No test-count regressions, no new skipped tests. P0 findings against shipped versions trigger out-of-band patch releases per section 1.5.
2. **Zero runtime dependencies.** Every feature is reachable with `node:*` builtins and `fetch`. Enforced by `npm run deps:zero` in the mandatory gate: the install-causing `package.json` fields (`dependencies`, `optionalDependencies`, `bundledDependencies`) stay empty. External integrations ship as optional, user-installed, dynamically imported adapters - never as dependencies.
3. **Isomorphic.** Every release passes the Node, Bun, Deno, and browser smoke suites. One runtime red blocks the release.
3a. **Minimal footprint.** The published bundle stays within the byte budget in `size-budget.json`. `npm run size` is part of the mandatory gate. A release over budget does not ship. Raising the budget is a deliberate, reviewed act with a rationale in the PR - never a silent bump to pass CI. The budget is tiered per the core/AI split (ADR-003): "core" is what a `new Skalex()` + CRUD + indexes + persistence needs. AI-native features that most data-path consumers do not call at runtime (MCP from alpha.10. Vector, quantization, and hybrid retrieval from 4.1) ship behind on-demand subpath entries with their own budget entries, never in the core default import. AI-native means one import away, not in every consumer's bundle.
4. **Breaking changes live in alpha and early beta.** alpha.10 is the last window for breaking public API changes. beta.1 is the last window for breaking on-disk format changes. After beta.2 the release is additive-only.
5. **Every release ships a `MIGRATION.md` section**, even a pure refactor.
6. **Docs and code move together.** A behavior change without matching JSDoc, `.d.ts`, `ARCHITECTURE.md`, and `README.md` updates is incomplete.

---

## 1.3 Alpha.7 release boundary

Alpha.7 includes the original shared-pipeline cleanup and the verified filesystem, authorization, mutation, query, memory and persistence fixes described in CHANGELOG.md. Transaction/migration callback restrictions and HTTP request validation require migration guidance. Explicit cloned reads and incomplete-flush acknowledgement are additive public capabilities.

Architecture and API follow-up fixes are implemented. Local qualification covers 1306 unit/integration tests, declaration and package contracts, four runtime smoke suites, and installed alpha.6 migration checks. Release materials are dated 2026-09-07. Publication approval remains pending. No WAL, new storage engine, snapshot-isolation redesign or core/AI extraction is added to alpha.7. Later release items remain subject to their own design and verification.

Before publication, verify an installed tarball, alpha.6 data compatibility, consumer declarations and the final release metadata. Delivery decision (2026-09-07): deliver the qualified fixes directly in alpha.7 instead of preparing a separate alpha.6 safety patch. This author-approved, release-specific exception reflects the completed alpha.7 safety work and migration qualification. The critical-issue policy remains unchanged for future incidents. This delivery decision does not authorize publication.

## 1.4 Required alpha.7 follow-up and later design work

The architecture/API review found defects in the existing alpha.6 behavior as well as the current candidate. Alpha.7 includes the following completed corrections with regression coverage:

1. Prevent ordinary saves from serializing uncommitted transaction state, including saves already queued before a lock is acquired.
2. Preserve a coherent ordinary collection-handle lifetime across reconnect and reload. Never acknowledge a write to an obsolete store.
3. Validate rename inputs before mutation and make collection registries safe for names that match JavaScript prototype properties.
4. Reject accidental replacement of an existing collection definition while preserving definitions registered before loading persisted data.
5. Use complete natural-language query identity for cache correctness.
6. Align CSV rows with a common column list.
7. Align runtime exports, connector error identity and public declarations, including method-specific find options.

This is safety and API correctness work, not a new storage engine. Shallow reads with explicit clone:true remain unchanged. Transaction callbacks retain their restricted capabilities. Concurrent transaction admission remains reject-while-active for this release.

Before implementing alpha.8, specify database lifecycle states, ordinary-handle lifetime, transaction/save admission, supported persisted values and adapter capabilities. Design transaction read visibility, rollback, commit and recovery semantics before the alpha.10 API freeze. Validate the consequential contracts with prototypes before freezing them. Beta implements and hardens agreed behavior rather than inventing new breaking semantics.

The storage, WAL and incremental-flush commitments remain in 4.0. Their protocols and benchmarks must distinguish ordinary saves from transaction commits, account for snapshot cost, and define the commit point and recovery outcome. Any later scope reduction requires a separate explicit decision.

## 1.4a Document ownership decision

Alpha.7 preserves existing shallow document reads and live `groupBy()` references. Detachment is explicit through `clone: true`, with structured-clone costs and compatibility limits documented at the read APIs.

This resolves F16 as an opt-in detachment contract, not safe-by-default reads. Mutating shared values can bypass validation, versioning, dirty tracking and transaction checks. Callers must use collection mutations for stored changes. Inputs, mutation results, hooks and event payloads retain their existing ownership behavior.

Default detachment and development-time freezing are not part of this change. Freezing requires separate compatibility and performance evaluation. F04 now has bounded synchronous commit-stage recovery, verified with one-shot faults and a separate recovery-failure guard. Neither this guarantee nor the revised F16 diagnostic establishes release readiness or arbitrary failure atomicity.

## 1.4b Performance and footprint work

The opportunities below come from code inspection and are investigation candidates, not confirmed optimizations or additional release promises. Their expected performance and bundle-size benefits are unverified unless supported by recorded measurements. Before implementation, each requires thorough investigation of correctness, compatibility, supported runtimes, representative workloads and total delivery cost. Investigation may conclude that no change should be made. Existing release commitments remain unchanged.

The alpha.7 experiments summarized below were investigated and excluded because their results did not meet the acceptance criteria. They are evaluated candidates, not uninvestigated opportunities. Their results do not establish benefits for the other candidates.

Target windows indicate when to evaluate them alongside committed work. Promote a candidate to implementation only after demonstrating a representative workload benefit, preserving behavioral contracts and passing the unchanged runtime, dependency and bundle gates. A small benchmark win alone does not justify more API or package complexity.

Alpha.7 already skips empty insert before-hooks and ordinary mutation after-hooks. Deferred transaction hooks remain intact. The three-way built-artifact insert benchmark records raw samples across index profiles and separates alpha.6, the prior candidate and the optimized build. Results depend on runtime, garbage collection and workload. Do not extrapolate plugin-free insert measurements to autosave, embeddings or registered hooks.

| Opportunity | Evaluation window | Required preparation and acceptance evidence |
| --- | --- | --- |
| Remaining empty query/search hook dispatch | Optional alpha.7 | Measure short indexed queries with zero plugins and registered plugins. Preserve hook ordering, late registration, errors and handle checks. Keep only repeatable gains. |
| Single-document unique-index bookkeeping | Optional alpha.7 | Measure avoiding a batch-local Set for one candidate. Preserve live-index collision checks, missing values, compound validation, replacement mode and recovery. No validation bypass. |
| Projection/population after unsorted pagination | alpha.8/alpha.9 | Characterize totals, empty pages, limit-only early stop, hook payloads and population failure/concurrency timing. Measure returned-page work versus all matched candidates. Treat observable timing changes as a contract decision. |
| Compound-index candidates for findOne | alpha.9 | Pin first-match ordering, visibility, undefined/null handling and additional predicates against scans. Existing index presence must not unexpectedly select a different matching document. Measure selectivity and fallback costs. |
| Provider implementation loading and MCP package boundaries | alpha.9/alpha.10 | Attribute bundle bytes before extraction. Preserve configuration ergonomics, constructor validation and error identity. Measure initial and first-use load costs, total package size and transitive lazy modules across ESM/CJS/browser consumers. Align with the already planned package split. |
| Compiled-filter reuse and operator-only updates | beta.3 | Define cache identity/invalidation for mutable filters, functions and regular expressions. Preserve schema, hooks, changelog and index consistency. Measure cache misses as well as repeated queries. |
| Atomic-adapter flush preflight optimization | After alpha.8 capability design, within persistence hardening | Specify all-or-nothing multi-entry writes, including wrappers and chunked batches. Prove crash/failure behavior before removing any marker I/O. An adapter label alone is insufficient. |
| Grouped filesystem saves | alpha.8 adapter capability investigation | Local prototypes improved multi-collection close time but did not establish neutral performance elsewhere. Neither ships in alpha.7. Define eligibility and bounded concurrency for adapters and wrappers. Preserve transaction barriers, wait for all sibling writes after failure, retain coalescing and full-save semantics. Measure single saves, shutdown, memory, JSON/gz, Node/Bun and bundle cost before adoption. |
| Incremental persistence | Existing storage work through beta.3 | Measure ordinary saves, autosaves and transactions separately, including snapshots, serialization, recovery and bytes written. Preserve the agreed commit/recovery protocol. This remains committed v4 work. |

Alpha.7 evaluation outcome: neither remaining micro-optimization is adopted. Skipping empty find hooks improved plugin-free queries but registered-hook medians increased in both repeated Bun and Node comparisons. Avoiding the single-document unique-batch Set improved Bun but regressed Node in the initial comparison. Retain the current implementation and revisit only with a design that meets the workload requirements. Search dispatch was not measured or changed. The query benchmark and hook characterization tests remain available for future work.

Preparation before expanding implementation:

1. Retain immutable alpha.6 and candidate artifacts with integrity hashes. Record exact entries, runtime versions, workload sizes, warmups, sample order and raw timings. Compare the same artifact type and measure without profiler overhead for final results.
2. Add workload-specific characterization tests when starting each candidate. Reuse scan/index equivalence, transaction ownership and failure-injection coverage. Avoid speculative APIs, capability flags or caches merely to prepare for future work.
3. Extend measurement coverage to registered hooks, autosave, embeddings and larger datasets as the relevant work starts. Keep ordinary CRUD measurements separate from those optional costs.
4. Report core gzip size, package archive size and lazy-module transfer separately. Keep the current hard core budget. Consider additional lazy-entry budgets during the package split without silently widening existing limits.
5. Keep alpha.7 bounded. Optional micro-optimizations must not delay the safety release for an open-ended performance campaign. After any accepted change, refresh the documentation bundle and qualify the final installed tarball before publication.

## 1.5 Critical-issue lane

P0 findings preempt the release train. They do not wait for the next planned release. A P0 is one of:

- **A correctness defect** - data loss, silent behaviour regression, broken invariant, or a violation of a documented contract.
- **A security vulnerability** - any path that lets untrusted input compromise confidentiality, integrity, or availability.

What this looks like in practice:

- A P0 confirmed against the most-recently-shipped version triggers a patch release on that version (e.g. `4.0.0-alpha.6.1`, `4.0.0-rc.1.1`, or `4.0.1` once the stable release has shipped), not a fold-in to the next planned release.
- The patch release ships out-of-band, in parallel with whatever in-flight planned release is open. The planned release is not delayed to absorb the fix.
- The patch release carries only the P0 fix and its regression test - no scope creep, no opportunistic refactors.
- If the next planned release inherits the P0 fix, it cherry-picks from the patch release rather than re-implementing.
- A P0 found during an in-flight release blocks that release until fixed. The verification matrix would fail anyway.

What does NOT preempt the train:

- P1, P2, and P3 findings queue against the next planned release whose scope fits, or against 4.1 when no fit exists.
- Performance regressions short of correctness failure wait for the beta.3 hot-path benchmark gate.
- Architecture opinions are not findings. They queue against the relevant design milestone.

The cutting order in section 7 does NOT apply to P0 fixes. Section 7 is for scope pressure on planned releases, not for triaging confirmed defects.

---

## 2. Release train

```
alpha.7 → alpha.8 → alpha.9 → alpha.10   │   beta.1 → beta.2 → beta.3   │   rc.1 → 4.0.0
         breaking-change window          │   storage / tx / polish      │   src/* freeze / stable
```

| Release | Theme | Breaking? | Effort |
|---|---|---|---|
| alpha.7 | Correctness and reliability fixes, restricted transaction/migration handles, DRY cleanup | Yes (callback capabilities) | Medium |
| alpha.8 | Lifecycle/store ownership, adapter capabilities, supported-value contract, versioned format and serializer extraction | Narrow if contracts require | Medium |
| alpha.9 | Validate transaction/persistence contracts and query semantics. Remaining correctness and security: MCP sanitization, `applyUpdate` strictness, AI move, query cache migration, error catalogue, MCP recall tools | Yes (narrow) | Medium |
| alpha.10 | Freeze only after storage/transaction-facing contract prototypes pass. Remaining final API surface: type-precision audit, `UpdateDescriptor<T>` fix, `findOne` types, deprecated removal, uniform return meta, MCP write contract freeze, MCP extraction to `skalex/mcp` + core/AI bundle split, `createCollection` + `db.ask` strictness, by-ID helpers, `hasCollection`, inline migrations, `MemoryAdapter` export, `db.config()` readback, package hygiene | Yes (last window) | Medium-Large |
| beta.1 | Storage engine: hybrid `DataStore` + `PersistenceBoundary`, WAL, unified save strategy, opt-in `durable: true` fsync, capability-getter migration | On-disk format v3 | Large |
| beta.2 | Harden agreed transaction semantics, rollback-failure handling, lifecycle interactions and agreed cancellation | Within the alpha.10 API freeze | Medium |
| beta.3 | Performance and polish: delete-path index usage, filter cache, operator-only update fast path, dirty-page incremental flush, events-async, changelog retention, feature-context refactor, stream iterator, `exists`/`has` shortcuts | No | Medium |
| rc.1 | Documentation, ADRs, migration guide, verification scripts | No | Small (no `src/*.js` changes) |
| 4.0.0 | Stable release | No | - |

---

## 3. Dependency graph

```
alpha.7 (correctness, reliability + DRY)
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
                beta.2 (harden agreed transactions on the stable persistence boundary)
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
- Explicit per-transaction handles shipped in alpha.7. Beta.2 hardens their integration with the beta.1 persistence boundary.
- Transaction admission, visibility, failure and cancellation contracts must be designed and prototyped by alpha.9, before alpha.10 freezes the API.
- In-memory rollback does not inherently depend on WAL. Disk recovery depends on the agreed beta.1 recovery protocol and adapter guarantees.
- `alpha.10` `Collection<T>` type-precision audit depends on `alpha.9` AI move (import paths change before types solidify).

Nothing in the release train depends on `beta.3`. rc.1 branches off `beta.3` cleanly because `beta.3` is additive-only.

---

## 4. Risk register

| Risk | Owning release | Mitigation |
|---|---|---|
| Lifecycle or save admission escapes transaction ownership | alpha.7/alpha.8 | Test saves queued before and during transactions, retained handles, reload, reconnect, rename and definition changes. |
| Store-split regressions drift sub-records | alpha.8 | Field-count assertion per sub-record. CI fails if a new field lands in one without its sibling. |
| On-disk format lock-in | alpha.8 | Fixture file per format version (`tests/fixtures/format-v1.dat`, `v2`, `v3`). Loader tests round-trip each. |
| `applyUpdate` strictness breaks users relying on lenient behavior | alpha.9 | One release of warning mode before throwing. `MIGRATION.md` documents the migration path. |
| Bulk-insert stack overflow in `InMemoryDataStore.push(...arr)` (reproduced on Node 24 at 70K+ docs) | alpha.9 | alpha.9 item #13 replaces the spread with a for-loop. Regression test at 100K / 500K pins the fix. Must land before alpha.10 freezes the API surface so input-size expectations stay truthful. |
| Type-precision gaps surface beyond `UpdateDescriptor<T>` | alpha.10 | Walk every public method with `tsd`. Fixes land in alpha.10 if narrow, defer to 4.1 with a tracked issue otherwise. |
| Hybrid DataStore regresses hot-path perf | beta.1 | Publish `insertOne` / `find` / `search` p50/p95/p99 from alpha.6 as a baseline. Gate beta.1 on `p95 ≤ alpha.6 × 1.05`. |
| WAL corruption under crash | beta.1 | Randomized crash fault injection, 1000 runs minimum. Invariant: post-recovery state equals last successfully committed state. |
| Per-tx wrapper drift (wrapper lifetime vs tx lifetime) | beta.2 | Tests cover: wrapper captured outside `fn` throws `ERR_SKALEX_TX_STALE_PROXY`. Wrapper state does not bleed between transactions. Bare `Collection` never participates in tx dispatch. Identical transaction suite runs on Node, Bun, Deno, and browser. |
| Rollback fails mid-sweep | beta.2 | `Promise.allSettled` per collection. Typed `ERR_SKALEX_TX_ROLLBACK_PARTIAL` with `details.failed`. Fault-injection test required. |
| Write throughput degrades as data grows (full-collection rewrite on every flush) | beta.3 | Dirty-page incremental flush (beta.3 #24): `_flush` writes only pages changed since the last flush, reusing the WAL's touched-page set. Gated by the flat-flush benchmark - a one-doc update on a 1M-doc collection flushes within 2× of the same op on a 1K-doc collection. |
| Hot-path perf regression slips into beta.3 | beta.3 | Benchmark gate in CI. Regression ≥ 5% fails the release. |
| Delete-path benchmark regression remains after beta.3 | beta.3 | Gate beta.3 on `deleteOne({ _id })` being ≥100× faster than alpha.6 baseline on a 100K-doc collection. |
| RC cycle too short | rc.1 | Tag 4.0.0 only when no open P0 issues exist and the maintainer is satisfied with rc.1 field exposure. No fixed soak length. Extend exposure on any P0 finding. |

---

## 5. Verification gates

Every release passes these before tagging:

```
bun run test
bun run build
bun run size
bun run lint
bun run deps:check
bun run deps:zero
bun run types:check
bun run smoke:node
bun run smoke:bun
bun run smoke:deno
bun run smoke:browser
```

Additional gates by release:

| Release | Extra gate |
|---|---|
| alpha.7 | Safety regressions, installed export/error identity and declaration tests, alpha.6 data compatibility |
| alpha.8 | Lifecycle/handle matrix, adapter capability conformance and format fixture round trips for v1 and v2 |
| alpha.9 | Transaction/persistence contract prototypes and positive/negative query API tests |
| alpha.10 | `tsd` positive and negative cases green. `api-surface.md` snapshot committed |
| beta.1 | 1000-run crash fault injection passes. Hot-path benchmark within 1.05× alpha.6 |
| beta.2 | Fire-and-forget + nested async tx tests green on every runtime (including browser) |
| beta.3 | Hot-path benchmark no worse than beta.1. `deleteOne({ _id })` ≥100× faster than alpha.6. One-doc-update flush scales with pages touched, not collection size |
| rc.1 | Zero code changes vs beta.3 in `src/*.js`. Docs coverage is 100% on the public surface |

---

## 6. Scope boundary

**In v4.0:** everything in the release train above. This includes the DataStore boundary, store split, transaction isolation with per-tx `Collection` wrappers, the full typed-error catalogue, `Collection<T>` generics refinement, MCP document sanitization, MCP write-contract freeze, WAL, unified save strategy, changelog retention, filter compilation cache, and operator-only update fast path.

**Deferred to 4.1:**

- Vector side-store and quantization
- Range / B-tree index for `$gt` / `$lt` - the "real query for user data" lever: turns range/inequality filters over user collections (subscribers by signup date, per-user prefs by tier) from full scans into indexed lookups, in RAM
- Lazy collection load - opt-in. `connect()` reads the manifest only and hydrates a collection on first access, with optional idle eviction. Reduces resident memory for the "many collections, one hot path" case without leaving the in-memory model
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

### Non-goals (written answers to recurring field asks)

Some asks recur because they sound reasonable but sit outside what Skalex is. Writing the boundary down here gives every future request a fixed answer, so the moat is not eroded one "reasonable" exception at a time.

- **Querying data that does not fit in RAM (out-of-core).** Skalex is in-memory by charter: a resident collection is fully in memory and queried there. Where users want this, the underlying need is usually (a) faster per-user filters - addressed in RAM by the range/B-tree index (4.1), (b) lower resident memory for cold collections - addressed by lazy collection load (4.1), or (c) not rewriting the whole file on every write - addressed by dirty-page incremental flush (beta.3 #24). True out-of-core querying requires the async-native disk-backed DataStore, and is v5 at the earliest. The beta.1 DataStore boundary is the seam that keeps it *possible* later without a rewrite. It is not a commitment to build it in v4 or 4.1.
- **Many parallel writers via transactions.** Transactions provide safe *isolation* (per-collection locking, atomic rollback - beta.2), not parallel write throughput: transactions are serialised. Within one process this is the intended model. Across processes it is a documented non-goal - two Skalex processes on the same directory are unsupported. The `multiProcessGuard` lockfile (beta.3 #15) turns that from silent corruption into a loud error. It is a guard, not multi-process support. Distributed or multi-process concurrency is not on any v4.x roadmap.

---

## 7. Cutting order if scope must shrink

When a release feels too large to land cleanly, remove items in this order (least painful first) rather than rushing or compressing the verification matrix:

1. `db.diagnostics()` → 4.1
2. Optional `{ meta: true }` return shape → 4.1
3. `AbortSignal` in transactions → 4.1
4. Post-restore audit trail → 4.1
5. Tokenizer hook stub → 4.1

Do NOT cut:

- Store split (alpha.8) - blocks DataStore
- Versioned on-disk format (alpha.8) - blocks future migrations
- Hybrid DataStore (beta.1) - blocks scalability story and hot-path performance charter
- WAL (beta.1) - blocks reliability claim
- Unified save strategy (beta.1) - blocks correct error reporting
- Accurate transaction contracts (design validated by alpha.9, hardened in beta.2) - rollback snapshots must never be described as snapshot isolation
- Explicit transaction ownership (implemented in alpha.7, hardened in beta.2) - preserve the capability and lifetime guarantees through storage changes
- `UpdateDescriptor<T>` precision fix (alpha.10) - last chance to fix a type that silently lets bad updates compile
- MCP sanitization (alpha.9) - security hardening
- Package exports (alpha.10) - users following the `.d.ts` hit runtime errors today
- Delete-path perf (beta.3) - required to meet the fastest-in-category benchmark target
- FsAdapter lockfile / `multiProcessGuard` (beta.3 #15) - reliability is the top project priority, and silent cross-process corruption is a correctness defect, not a nicety. The guard turns it into a loud error. Do not cut it to 4.1. Ship the safety net in the same release that ships the transaction isolation story
- Dirty-page incremental flush (beta.3 #24) - the measured guarantee behind "write throughput does not degrade as data grows." Cutting it reintroduces full-collection rewrite on every flush

---

## 8. Pacing

Skalex releases ship on a quality-gated cadence, not a calendar one. There are no fixed delivery dates between alpha.6 and 4.0.0, no target date for any individual release, and no minimum or maximum gap between releases.

What this means in practice:

- **No release has a target date.** A release is done when its verification matrix passes and its `MIGRATION.md` section is merged. Until then it stays open with no schedule pressure.
- **No minimum soak periods on a calendar.** Stability gates are state-based ("no open P0 issues", "two consecutive clean CI runs", "satisfied with field exposure of the rc.1 build"), not date-based. A release that has been stable in the wild for two days under heavy real-world use is no less ready than one that has been stable for a month under light use.
- **Order is dictated by the dependency graph in section 3. Pace is dictated by readiness against the verification matrix.** Releases land when they meet their gates, not when a clock says they should.
- **Scope is the lever, not pace.** If a release feels too big to land in one pass, drop items in the cutting order in section 7 - never compress correctness or skip the verification matrix to ship faster.
- **Effort labels in per-release docs ("Trivial", "Small", "Medium", "Large") are sizings relative to each other.** They help order work within a release. They do not represent wall-clock estimates.

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
