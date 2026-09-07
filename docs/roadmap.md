# Roadmap <!-- {docsify-ignore} -->

The [v4 release plan](https://github.com/TarekRaafat/skalex/blob/master/design/v4-release-plan.md) defines committed scope and release gates. Releases follow verified readiness, not fixed dates.

Skalex remains an in-memory, local-first database with AI capabilities, zero runtime dependencies and a fixed bundle budget. Multi-process writers, distributed coordination and out-of-core queries are not v4 goals.

## Alpha.7: correctness and API safety

Implemented work includes mutation/index recovery, explicit transaction ownership and restricted handles, ordered saves, incomplete-batch detection, filesystem and MCP safety, corrected queries and memory compression, and opt-in cloned reads.

Required follow-up:

- [x] Prevent independent saves from persisting uncommitted transaction data.
- [x] Keep ordinary collection handles coherent across reconnect and reload.
- [x] Validate collection rename inputs and support prototype-like collection names.
- [x] Prevent accidental replacement of existing collection definitions.
- [x] Eliminate natural-language query cache collisions.
- [x] Keep CSV values aligned with their columns.
- [x] Align package exports, connector error identity and method-specific declarations.
- [x] Verify installed consumers, alpha.6 migrations, declarations and all four runtime targets.
- [x] Record direct alpha.7 delivery and date the release materials.
- [ ] Obtain publishing approval.

See [migration guidance](migration.md) for implemented behavior and upgrade requirements. Pending items above are not claims that the implementation already supports them.

## Alpha.8: lifecycle and persistence foundation

Define lifecycle transitions and handle validity. Strengthen store ownership, extract serialization, version persisted formats and specify supported values. Make adapter capabilities accurate, including through encryption wrappers. Verify reconnect/load/rename/reset behavior and legacy format compatibility.

## Alpha.9: query contracts and design validation

Complete query/update strictness and security work. Validate transaction admission, read visibility, failure handling and persistence recovery contracts with prototypes before freezing their API. Keep the distinction between rollback snapshots and read isolation explicit.

## Alpha.10: validated API freeze

Align runtime, types, examples and package entry points. Complete the planned optional-feature package boundaries within the bundle budget. Freeze storage/transaction-facing contracts only after the prototypes demonstrate their behavior. New convenience methods must justify their complexity.

## Beta: implementation, hardening and measurement

- beta.1 implements the agreed DataStore/persistence boundary, recovery protocol and versioned storage layout.
- beta.2 hardens agreed transaction semantics, rollback failures and lifecycle interactions across runtimes.
- beta.3 delivers measured performance improvements, incremental persistence and selected additive polish.

WAL and incremental persistence remain committed v4 work. Benchmarks must include transaction snapshot costs and distinguish ordinary saves, autosaves and transaction commits. Recovery requires a defined commit point and adapter-specific guarantees.

## Performance and bundle opportunities

The [performance work register](https://github.com/TarekRaafat/skalex/blob/master/design/v4-release-plan.md#14b-performance-and-footprint-work) records evaluation windows, dependencies and acceptance evidence. These candidates come from code inspection, not confirmed performance or bundle-size gains. Benefits remain unverified unless backed by recorded measurements. Each requires thorough correctness, compatibility, runtime, workload and delivery-cost investigation before implementation, and may be rejected. Existing release commitments remain unchanged. The two alpha.7 candidates below were investigated and excluded, rather than left unverified.

- Alpha.7 evaluated remaining empty find-hook dispatch and single-document uniqueness bookkeeping. Neither was adopted because improvements did not hold across the required workloads. Keep the benchmark and behavior tests for future investigation.
- Alpha.8/alpha.9 can evaluate unsorted page projection/population and compound-index use in findOne after pinning ordering and failure semantics.
- Alpha.9/alpha.10 evaluates provider loading and MCP package boundaries as part of the planned package split. Track core bytes, total package size and first-use loading separately.
- Beta performance work includes the planned filter cache, operator-only updates and incremental persistence. Removing redundant flush preflight requires proven adapter atomicity first.

Preparation centers on reproducible artifact benchmarks and behavioral tests. New APIs, caches and adapter flags should follow demonstrated need. Local plugin-free insert improvements do not establish performance for embeddings, persistence or plugin-heavy applications.

## RC and stable

Qualify the final installed package, migration paths, documentation and field behavior. Keep the existing zero-dependency, bundle-size and four-runtime gates. Publish only after release approval.

## Later releases

The v4 plan retains range indexes, lazy collection loading, vector side-storage/quantization, broader memory retrieval and selected internal extraction for 4.1. Partial-prefix compound indexes and further adapter work remain later items. Out-of-core storage and nested savepoints remain v5 considerations.

Copy-on-write or persistent structures require a separate compatibility/performance decision. They are not automatic requirements for alpha.7 and do not by themselves solve conflict handling or durability.

Replication, CRDT collaboration, graph APIs, REST/GraphQL servers and additional integrations are exploratory ideas, not commitments in the v4 release train. A future proposal must preserve the local-first model, runtime portability and size constraints.
