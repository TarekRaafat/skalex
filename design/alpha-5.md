# alpha.5 Release Plan

**Status:** Pending alpha.4 completion
**Version:** v4.0.0-alpha.5
**Prerequisite:** alpha.4 shipped.
**Gate:** alpha.5 does not ship until every item passes regression tests and all existing tests remain green.
**Rule:** alpha.5 is a tactical cleanup release. No new user-facing features, no architectural decomposition, no breaking changes.
**Theme:** Close alpha.4 review gaps, tighten process, reduce cruft.

---

## P2 - Tactical Cleanup

### 1. Replace `_MUTATION_METHODS` hardcoded set with declarative marker

**Severity:** P2 - maintainability
**Effort:** Small

**Problem:** `src/engine/transaction.js` lines 13-16 hardcode the list of Collection mutation methods:

```js
const _MUTATION_METHODS = Object.freeze(new Set([
  "insertOne", "insertMany", "updateOne", "updateMany",
  "upsert", "upsertMany", "deleteOne", "deleteMany", "restore",
]));
```

Adding a new mutation method (e.g. `patchMany`, `replaceOne`) requires updating both the method AND this set. Forgetting the set update silently disables the collection lock check for the new method. No test catches the omission.

**Fix options:**

- **(A)** Declarative naming convention: any method whose name starts with `insert`, `update`, `upsert`, `delete`, or `restore` is a mutation. Check via regex in the proxy `get` trap.
- **(B)** Method metadata: attach `method._isMutation = true` inside each public mutation method (or via a wrapping helper) and check for the flag.
- **(C)** Derive from `MutationPipeline.execute` callers: every method that calls `this._pipeline.execute` is a mutation. Identify at module-load time via static analysis or runtime inspection.

**Recommendation:** Option A for alpha.5. Simplest, no method body changes, regex is deterministic. The naming convention is already consistent — enforce it.

**Scope:** `src/engine/transaction.js`, plus a regression test that adds a new mutation method name and verifies the proxy wraps it.

**Test:** Add a mock method starting with `insert` to the Collection prototype in a test, verify the proxy's depth counter wraps it without needing the set update.

**Depends on:** None.

---

### 2. Automated release gate

**Severity:** P2 - process
**Effort:** Medium

**Problem:** `agent_docs/releases.md` documents the mandatory gate (`npm test && npm run build && npm run lint && npm run deps:check && npm run types:check`) but nothing enforces it. Contributors can commit without running any of these. Regressions that take 5 review rounds to catch (see alpha.4 review) could be caught on first commit.

**Fix options:**

- **(A)** Pre-commit hook via husky / simple-git-hooks running the full gate on `git commit`. Adds a runtime dependency (husky) or a postinstall script.
- **(B)** GitHub Actions CI that runs the gate on every PR. Catches regressions before merge, no local-side impact. Requires CI config and budget.
- **(C)** Skalex-native script: `npm run verify` that runs everything, documented as the mandatory command before every commit. No enforcement, but canonical invocation.

**Recommendation:** Option B + C for alpha.5. CI catches everything at merge time; the `verify` script gives contributors a single command to run locally. Option A requires a runtime dependency, which violates the zero-deps rule.

**Scope:** `.github/workflows/verify.yml` (new), `package.json` scripts.

**Test:** Push a branch with a failing test, verify CI blocks the merge. Run `npm run verify` locally, verify it exits non-zero on any gate failure.

**Depends on:** None.

---

### 3. Tests using `CollectionContext.forTesting()`

**Severity:** P3 - validation
**Effort:** Small

**Problem:** alpha.4 added `src/engine/collection-context.js` with a `forTesting(overrides)` factory for isolated Collection testing. No test uses it. The factory works in theory but is unproven for its intended use case.

**Fix:** Rewrite 2-3 existing Collection unit tests to use `forTesting()` instead of constructing a full Skalex instance. Verify the factory covers enough of the context surface to support real test scenarios. Document the factory usage pattern in `agent_docs/testing.md`.

**Scope:** `tests/unit/collection-features-isolated.test.js` (new), `agent_docs/testing.md`.

**Test:** The new isolated tests run without importing Skalex. If they pass, the factory is validated.

**Depends on:** None.

---

### 4. Browser build `node:*` stub automation

**Severity:** P3 - tooling
**Effort:** Small

**Problem:** The alpha.4 review caught a build break where `node:util` was imported without being in Rollup's `external` list. The stub list in `rollup.config.js` is manually maintained. A new `node:*` import that isn't in the list silently breaks the browser build. `npm run build` catches it at build time, but ideally the stub list would be automatically derived.

**Fix:** Pre-build step that greps source for `import ... from "node:*"` and validates every unique module is in the Rollup `external` array. Exit non-zero if a new `node:*` import isn't in the list.

**Scope:** `scripts/verify-node-stubs.mjs` (new), `rollup.config.js`, `package.json` scripts.

**Test:** Add a stray `import "node:fs/promises"` to a source file, run the verify script, assert it errors with the missing module name.

**Depends on:** None.

---

### 5. Reduce module sprawl

**Severity:** P3 - maintainability
**Effort:** Small

**Problem:** alpha.4 decomposition produced some files that are disproportionately small relative to the overhead of a file jump:

- `src/engine/document-builder.js` - 41 lines, one exported function
- `src/engine/exporter.js` - 62 lines, one exported function
- `src/engine/vector-search.js` - 58 lines, two exported functions

These were extracted for separation of concerns, but at this size the file boundary costs more than it earns.

**Fix:** Consider merging trivially small extracted modules back into a shared file (e.g. `src/engine/collection-ops.js` holding document-builder + exporter + vector-search as co-located functions). Keep QueryPlanner and DataStore separate — they have substantial surface area.

This is a judgment call. Needs architectural review. The alternative is to keep the current split and accept the navigation overhead.

**Scope:** `src/engine/collection-ops.js` (new, optional), imports in `src/engine/collection.js`.

**Test:** All existing tests pass unchanged. No behaviour change.

**Depends on:** None. Can be decided during alpha.5 scoping.

---

### 6. Test audit: remove tautological tests

**Severity:** P3 - test quality
**Effort:** Small

**Problem:** Some alpha.4 tests are tautological — they verify that a constant equals itself. Example: `tests/unit/constants.test.js` asserts `Hooks.AFTER_RESTORE === "afterRestore"`. If the constant is wrong, every other test that uses it also fails. The tautological test adds no signal.

**Fix:** Audit the test suite for tests that don't add independent verification. Remove or restructure them to test behavior instead of constant values.

Candidates for removal:
- `Hooks.AFTER_RESTORE` constant pin (covered indirectly by afterRestore hook tests)
- `Ops.X` constant pins
- MCP version pin (already replaced with dynamic read in alpha.4 pre-publish)

**Scope:** `tests/unit/constants.test.js`, possibly others.

**Test:** Reduction in test count does not decrease coverage (measured via `--coverage`).

**Depends on:** None.

---

## Regression Test Requirements

| Fix | Test scenario |
|-----|---------------|
| #1 (declarative mutation marker) | Mock method starting with "insert" is wrapped by the tx proxy without manual list update |
| #2 (automated gate) | CI blocks PR on any gate failure; `npm run verify` exits non-zero on local gate failure |
| #3 (forTesting tests) | Collection CRUD tests pass using only `forTesting()` factory, no Skalex import |
| #4 (node: stub automation) | Adding a new `node:*` import without updating the stub list fails the verify script |
| #5 (module consolidation) | All existing tests pass after merging |
| #6 (test audit) | Coverage report confirms no regression in line/branch coverage after test removal |

---

## Verification Matrix

alpha.5 requires:

- `npm run verify` (includes test + build + lint + deps:check + types:check)
- `npm run smoke` (all four runtimes)
- CI run on the tag commit

---

## Success Criteria

alpha.5 is done when:

1. Mutation methods are identified declaratively (no hardcoded set to maintain).
2. CI enforces the release gate on every PR.
3. `CollectionContext.forTesting()` is validated by real test usage.
4. Browser build `node:*` stub list is automatically verified.
5. Any tactical module consolidation decision is documented.
6. Test suite no longer contains tautological tests.
7. All regression tests pass.

---

## Out of Scope for alpha.5

| Item | Tracking |
|---|---|
| Complete DataStore abstraction | beta.1 |
| Per-module explicit dependencies | beta.1 |
| AsyncLocalStorage tx proxy | beta.1 |
| WAL | beta.1 |
| BigInt out-of-band metadata | beta.1 |
| New user-facing features | beta |

---

## Execution Order

1. **#1** (declarative mutation marker) - small, contained, improves maintainability immediately.
2. **#4** (node: stub automation) - small, prevents a recurring build break.
3. **#2** (automated gate) - larger, but enables everything else.
4. **#3** (forTesting tests) - validates alpha.4 work.
5. **#6** (test audit) - cleanup pass.
6. **#5** (module consolidation) - last, requires consensus.
