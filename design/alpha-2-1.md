# alpha.2.1 Release Plan

**Status:** Pending
**Version:** v4.0.0-alpha.2.1
**Prerequisite:** All alpha.2 items resolved and shipped.
**Gate:** alpha.2.1 does not ship until every item passes regression tests and all existing tests remain green.
**Rule:** Correctness-only patch. No refactors, no new features, no architecture changes.
**Theme:** Fix two correctness bugs that block the migration and connect-retry models.

---

## P0 - Correctness Fixes

### 1. Fix connect-time migration deadlock

**Issue:** None
**Severity:** P0 - critical
**Effort:** Small

**Problem:** `connect()` stores `_connectPromise` before `_doConnect()` finishes
([index.js:174](../src/index.js#L174)). Migrations run before `isConnected`
becomes true ([index.js:190](../src/index.js#L190) vs
[index.js:206](../src/index.js#L206)). Collection mutations inside a migration
call `ensureConnected()` ([collection.js:124](../src/engine/collection.js#L124)),
which calls `connect()` ([index.js:242-245](../src/index.js#L242)), which
returns the same still-pending `_connectPromise`. The migration awaits the
promise it is executing inside. Self-deadlock.

Current tests only cover `MigrationEngine` in isolation with no-op `up()`
functions. No test exercises a migration that calls `insertOne()`,
`updateOne()`, or any collection write API during `db.connect()`.

**Fix:** Set a `_bootstrapping` flag before migrations run. `_ensureConnected()`
returns immediately when `_bootstrapping` is true - the database is already
loaded, the caller is inside the connect lifecycle:

```js
async _ensureConnected() {
  if (this.isConnected || this._bootstrapping) return;
  return this.connect();
}
```

Set the flag in `_doConnect()`:

```js
async _doConnect() {
  try {
    await this.loadData();
    this._bootstrapping = true;
    // ...run migrations...
    this._bootstrapping = false;
    this.isConnected = true;
    // ...
  } catch (err) {
    this._bootstrapping = false;
    // ...
  }
}
```

**Scope:** `src/index.js`

**Test:**
1. Create a `Skalex` instance with a migration that calls `col.insertOne()`
2. Call `db.connect()`
3. Assert connect resolves (does not hang)
4. Assert the migration's inserted document exists in the collection
5. Create a migration that calls `col.updateOne()` on a seeded document
6. Assert connect resolves and the update is applied

**Depends on:** None

---

### 2. Fix failed connect() not recoverable

**Issue:** None
**Severity:** P0 - critical
**Effort:** Trivial

**Problem:** `_connectPromise` is assigned at [index.js:174](../src/index.js#L174)
and never cleared on failure. The catch block at
[index.js:210](../src/index.js#L210) only logs and re-throws. Subsequent
`connect()` calls hit the early return at [index.js:173](../src/index.js#L173),
returning the same rejected promise forever. Transient adapter or filesystem
errors permanently brick the instance.

**Fix:** Clear `_connectPromise` on failure so `connect()` can be retried:

```js
async connect() {
  if (this._connectPromise) return this._connectPromise;
  this._connectPromise = this._doConnect().catch((err) => {
    this._connectPromise = null;
    throw err;
  });
  return this._connectPromise;
}
```

**Scope:** `src/index.js`

**Test:**
1. Create a `Skalex` instance with an adapter that throws on first `read()`
2. Call `db.connect()` - assert it rejects
3. Fix the adapter (stop throwing)
4. Call `db.connect()` again - assert it resolves successfully
5. Assert the instance is fully usable after recovery

**Depends on:** None

---

## Regression Test Requirements

| Fix | Test scenario |
|-----|---------------|
| #1 (migration deadlock) | `db.connect()` with a migration that calls `col.insertOne()` - resolves, document exists |
| #2 (connect recovery) | `db.connect()` fails, adapter recovers, second `db.connect()` succeeds |

---

## Verification Matrix

alpha.2.1 is not done when only the new tests pass. The release must also verify:

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

alpha.2.1 is done when:

1. A migration that uses collection write APIs during `db.connect()` resolves without deadlock.
2. A failed `connect()` does not brick the instance - subsequent retries work after the underlying error clears.
3. All existing tests pass unchanged.
4. All regression tests exist and pass.
5. The verification matrix passes.

---

## Out of Scope for alpha.2.1

Everything else. This is a targeted correctness patch.
