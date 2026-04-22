# Skalex Migration Guide

This file collects every upgrade guide Skalex v4 has shipped. Start with the section matching the version you are upgrading from.

- [4.0.0-alpha.4 → 4.0.0-alpha.5](#400-alpha4--400-alpha5) (no breaking changes)
- [4.0.0-alpha.3 → 4.0.0-alpha.4](#400-alpha3--400-alpha4)
- [4.0.0-alpha.2.x → 4.0.0-alpha.3](#400-alpha2x--400-alpha3)
- [v3 → v4.0.0-alpha.1](#v3--v4)

---

## 4.0.0-alpha.4 → 4.0.0-alpha.5

**No breaking changes.** alpha.5 is a tactical cleanup release: automated release gate, CI enforcement, `node:*` stub validator, isolated Collection testing pattern, and a naming-convention regex replacing the `_MUTATION_METHODS` hardcoded set.

No API changes. No behaviour changes. Drop-in upgrade:

```sh
npm install skalex@4.0.0-alpha.5
```

No other action required.

---

## 4.0.0-alpha.3 → 4.0.0-alpha.4

alpha.4 is an architecture decomposition and hardening release. It extracts modules from the monolithic Collection and Skalex classes, tightens transaction isolation, and normalizes error types across the engine. Five breaking changes require code updates.

### 1. Non-transactional writes to transaction-locked collections throw

Collections touched by an active transaction are now locked. Any write from outside the transaction throws `TransactionError` with `ERR_SKALEX_TX_COLLECTION_LOCKED` until the transaction commits or rolls back. Previously, outside writes silently landed and could be clobbered by rollback.

#### Before

```js
await db.transaction(async (tx) => {
  const users = tx.useCollection("users");
  await users.insertOne({ name: "Alice" });

  // Outside write - silently succeeded, but rollback would clobber it
  const outside = db.useCollection("users");
  await outside.insertOne({ name: "Bob" }); // worked
});
```

#### After

```js
await db.transaction(async (tx) => {
  const users = tx.useCollection("users");
  await users.insertOne({ name: "Alice" });

  // Outside write - now throws
  const outside = db.useCollection("users");
  await outside.insertOne({ name: "Bob" });
  // TransactionError: ERR_SKALEX_TX_COLLECTION_LOCKED
});
```

#### Migration steps

1. Move any writes that target a collection used inside a transaction into the transaction callback.
2. If you intentionally wrote to a collection from outside a concurrent transaction, restructure so the writes happen before or after the transaction.

### 2. `PluginEngine.register()` throws `ValidationError` instead of `TypeError`

Passing an invalid plugin (non-object, null, or missing hooks) to `db.use()` now throws `ValidationError` with a stable `ERR_SKALEX_VALIDATION_PLUGIN` code instead of a bare `TypeError`.

#### Before

```js
try {
  db.use(null);
} catch (e) {
  e instanceof TypeError; // true
}
```

#### After

```js
try {
  db.use(null);
} catch (e) {
  e instanceof ValidationError; // true
  e.code === "ERR_SKALEX_VALIDATION_PLUGIN"; // true
}
```

#### Migration steps

Replace any `catch` blocks that check for `TypeError` from `db.use()` with `ValidationError` checks.

### 3. Browser/worker environments without an adapter throw `ERR_SKALEX_ADAPTER_REQUIRED`

Constructing a Skalex instance in a browser or worker environment without passing an explicit `adapter` now throws `AdapterError` with `ERR_SKALEX_ADAPTER_REQUIRED` at construction time. Previously, the default `FsAdapter` was silently loaded and failed with a cryptic stub error at `connect()`.

#### Before

```js
// In browser - failed at connect() with unclear error
const db = new Skalex();
await db.connect(); // Error: fs.mkdirSync is not a function
```

#### After

```js
// In browser - fails immediately with clear message
const db = new Skalex();
// AdapterError: ERR_SKALEX_ADAPTER_REQUIRED

// Fix: pass a browser-compatible adapter
const db = new Skalex({ adapter: new LocalStorageAdapter({ namespace: "myapp" }) });
```

#### Migration steps

If you construct Skalex in a browser or worker without an `adapter` option, pass a `LocalStorageAdapter` (or a custom adapter) explicitly.

### 4. All adapter throws are now typed `AdapterError` with stable codes

Storage and AI adapter errors that previously threw bare `Error` or `TypeError` now throw `AdapterError` with stable `ERR_SKALEX_ADAPTER_*` codes. This affects error handling in `catch` blocks that checked for `Error` type.

#### Before

```js
try {
  await db.connect();
} catch (e) {
  e instanceof Error; // true, but no stable code
}
```

#### After

```js
try {
  await db.connect();
} catch (e) {
  e instanceof AdapterError; // true
  e.code; // "ERR_SKALEX_ADAPTER_READ_FAILED", "ERR_SKALEX_ADAPTER_WRITE_FAILED", etc.
}
```

#### Migration steps

Update `catch` blocks that handle adapter-related errors to check for `AdapterError` and use the `code` property for programmatic handling.

### 5. `find()` limit-only fast path omits `totalDocs` / `totalPages`

When `find()` is called with `limit` but without `page`, it now uses an early-termination fast path that skips the full sort and count. The result omits `totalDocs` and `totalPages` (they are `undefined`). Previously, `find({ limit: 10 })` computed the full total even though no pagination was requested.

#### Before

```js
const result = await users.find({}, { limit: 10 });
result.totalDocs;  // number (e.g. 1000)
result.totalPages; // number (e.g. 100)
```

#### After

```js
const result = await users.find({}, { limit: 10 });
result.totalDocs;  // undefined
result.totalPages; // undefined

// To get totals, request a page explicitly:
const paged = await users.find({}, { limit: 10, page: 1 });
paged.totalDocs;  // 1000
paged.totalPages; // 100
```

#### Migration steps

1. If your code reads `totalDocs` or `totalPages` from a `find()` call that only passes `limit` (no `page`), add `page: 1` to preserve the old behavior.
2. If you only need the first N results and don't use the totals, no change needed - you get a free performance improvement.

---

## 4.0.0-alpha.2.x → 4.0.0-alpha.3

alpha.3 is a runtime-safety and hardening release. It introduces no new user-facing features, but it tightens several public API boundaries so that previously silent failures now throw loudly. Every break below has a mechanical fix; none require rethinking data shapes.

Work through each section in order. Most codebases will need changes in sections 1, 2, and 3; the rest are narrower.

### 1. `Migration.up()` receives the Skalex proxy

The migration callback signature changed from `up(collection)` to `up(db)`. The old `collection` parameter was always an internal scratch collection named after the migration version and was almost never useful. The new `db` is the transactional Skalex proxy, so every collection the migration touches participates in the same rollback scope.

#### Before

```js
db.addMigration({
  version: 1,
  up: async (col) => {
    // col was always db.useCollection("_migration_1") - rarely what you wanted
    const users = db.useCollection("users"); // reached via closure
    for (const user of (await users.find({})).docs) {
      await users.updateOne({ _id: user._id }, { $set: { role: "user" } });
    }
  },
});
```

#### After

```js
db.addMigration({
  version: 1,
  up: async (db) => {
    const users = db.useCollection("users");
    for (const user of (await users.find({})).docs) {
      await users.updateOne({ _id: user._id }, { $set: { role: "user" } });
    }
  },
});
```

#### Migration steps

1. Replace `async (col) =>` with `async (db) =>` in every `addMigration` call.
2. Delete any lines that reached for `col` directly. If a migration was using `col` to access its scratch collection, rewrite it to use a properly-named collection via `db.useCollection(name)`.
3. Each migration now runs inside its own transaction. If a migration throws partway through, every write it made rolls back and `_meta.appliedVersions` is NOT recorded - so the migration reruns cleanly on the next `connect()`. Previously a partial migration could leave the DB half-upgraded and the version still recorded.

### 2. `Memory.tokenCount()` and `Memory.context()` are async

Both methods now read through the public Collection `find()` API (honouring soft-delete and auto-connect) and return a `Promise`.

#### Before

```js
const mem = db.useMemory("chat-42");
const { tokens } = mem.tokenCount();
const ctx = mem.context({ tokens: 4000 });
```

#### After

```js
const mem = db.useMemory("chat-42");
const { tokens } = await mem.tokenCount();
const ctx = await mem.context({ tokens: 4000 });
```

#### Migration steps

1. Grep your codebase for `.tokenCount(` and `.context(` on Memory instances. Add `await` to every call and ensure the surrounding function is `async`.
2. If you were calling either before `connect()`, they now trigger auto-connect instead of silently returning empty results - no action needed.

### 3. Session IDs and collection names are validated

`db.useMemory(sessionId)`, `db.useCollection(name)`, and `db.createCollection(name)` now reject names that don't match the new safety regex:

- **Collection names:** `/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,63}$/` (1-64 chars, starts with letter/digit/underscore, no path characters)
- **Session IDs:** `/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,55}$/` (1-56 chars to leave room for the internal `_memory_` prefix)

Invalid names throw `ValidationError` with `ERR_SKALEX_VALIDATION_COLLECTION_NAME` or `ERR_SKALEX_VALIDATION_SESSION_ID` at construction time, not on first use. Characters previously allowed that are now rejected include `/`, `\`, `..`, `\x00`, whitespace, and anything outside `[a-zA-Z0-9_.:-]`.

#### Migration steps

1. Audit collection names you create from user input. If you accepted arbitrary strings (e.g. email addresses with `@`, UUIDs with surrounding whitespace), sanitise them at the call site. A simple `.replace(/[^a-zA-Z0-9_.:-]/g, "_")` is usually enough.
2. Session IDs follow the same rule with a tighter length budget. If you were using long UUIDs or URL-safe base64 tokens, confirm they fit within 56 characters and only use the allowed character class.
3. Internal collection names (`_meta`, `_changelog`, `_memory_*`) already pass the check. No action needed for those.

### 4. Public API methods reject invalid argument types

`insertOne`, `insertMany`, `updateOne`, `updateMany`, `upsert`, `upsertMany`, `deleteOne`, `deleteMany`, `restore`, `find`, `findOne`, and `search` now throw `ValidationError` with `ERR_SKALEX_VALIDATION_ARG` when given `null`, a primitive, an array where an object was expected, or a non-object/non-function filter. Previously these calls failed deep inside with unclear stack traces or silently returned nothing.

#### Before (worked, badly)

```js
await users.insertOne(null);        // silently no-op'd or crashed later
await users.find("id123");           // returned zero results
await users.updateOne(undefined, { $set: { x: 1 } });
```

#### After (throws at the boundary)

```js
await users.insertOne({ name: "ok" });
await users.find({ _id: "id123" });
await users.updateOne({ _id: "id123" }, { $set: { x: 1 } });
```

#### Migration steps

Grep for any call site that passes `null`, `undefined`, a bare string, or a number to these methods. Wrap the argument in the correct shape. If your code was intentionally passing `null` to "match all", replace it with `{}`.

### 5. After-hook errors no longer abort transactions by default

Deferred side effects - `afterInsert` / `afterUpdate` / `afterDelete` plugin hooks, `watch()` callbacks, and changelog entries - run *after* a transaction commits. In alpha.2.x an error thrown from any of them surfaced to the caller and could make it look like the transaction itself had failed, even though the data was already on disk.

The new default is `deferredEffectErrors: "warn"`: the error is logged via the configured logger, every other deferred effect still runs, and the successful commit result is returned.

#### If you want the old behaviour

```js
// Instance-wide
const db = new Skalex({
  adapter,
  deferredEffectErrors: "throw",
});

// Or per-transaction
await db.transaction(async (tx) => {
  // ...
}, { deferredEffectErrors: "throw" });
```

The `"throw"` strategy raises an `AggregateError` *after* the commit has landed. The data is still on disk; the error only surfaces the fact that a post-commit effect failed.

#### Migration steps

1. Decide which strategy matches your app. If you treat after-hooks as advisory (audit logs, cache warming, metrics), keep `"warn"` - you don't need to change anything.
2. If you rely on after-hook errors to abort the caller's operation, pass `deferredEffectErrors: "throw"` and catch `AggregateError` at the call site. Remember the data is already committed; rolling back is your responsibility.
3. A third option, `"ignore"`, silently swallows all deferred errors. Use it only for background cleanup transactions where you explicitly don't want noise.

### 6. Nested transactions throw instead of deadlocking

```js
// Before: deadlocked forever
await db.transaction(async () => {
  await db.transaction(async () => {}); // never returned
});

// After: throws synchronously
// TransactionError: ERR_SKALEX_TX_NESTED
```

#### Migration steps

Refactor any code that called `db.transaction()` from inside another `db.transaction()` callback. The inner logic usually belongs in the outer callback directly - Skalex's transaction proxy already lets you touch any collection inside the active tx.

### 7. `$regex` string filters are length- and ReDoS-checked

`$regex` values passed as strings to `find()`, `findOne()`, etc. are now capped at 500 characters and rejected if they contain catastrophic-backtracking patterns (nested unbounded quantifiers). Pre-compiled `RegExp` instances bypass both checks and are treated as trusted.

#### Before (accepted anything)

```js
await users.find({ name: { $regex: hugeUserInputString } });
```

#### After (throws on suspicious patterns)

```js
// Preferred: validate and compile yourself if you trust the source
const re = new RegExp(userInput);
await users.find({ name: { $regex: re } });

// Or keep the string form and let Skalex guard you
await users.find({ name: { $regex: "^[a-z]+$" } }); // fine, short and safe
```

#### Migration steps

If you feed user-supplied regex into filters, either compile them yourself with `new RegExp()` (taking responsibility for validation) or ensure they fit within 500 characters and don't use nested `*` / `+` quantifiers.

### 8. MCP agent filters strip `$fn` and cap at depth 16

If you expose Skalex to an LLM agent over MCP, filters from the agent are sanitised before they reach the Collection API:

- Every `$fn` key is removed (including inside `$or`, `$and`, `$not`) and a warning is logged. Agents can no longer inject raw JavaScript predicate functions via MCP because the filter payload is untrusted - a prompt-injected instruction could otherwise smuggle arbitrary code into the host process.
- Filters nested deeper than 16 levels throw `ValidationError` with `ERR_SKALEX_VALIDATION_FILTER_DEPTH`.

Direct `find()` calls from your own server-side code are **not** affected - only the MCP tool handlers sanitise. `$fn` remains fully supported for direct callers.

> **Coming in alpha.4:** `db.mcp({ predicates })` will let developers register named server-side predicates that agents invoke by name, restoring `$fn` expressiveness over MCP without letting code cross the wire. Tracked as item #22 in `design/alpha-4.md`. If you are on alpha.3 and need the agent to express a `$fn`-style predicate today, register it as a dedicated MCP tool or a server-side plugin; move to the allowlist model when alpha.4 ships.

#### Migration steps

1. If your agent relied on `$fn` predicates, pick one of:
   - **Short-term (alpha.3):** expose the predicate as a dedicated MCP tool or run it inside a server-side plugin. The agent calls the tool instead of sending a function.
   - **Medium-term (alpha.4):** register the predicate in `db.mcp({ predicates: { myCheck: (doc) => ... } })` and let the agent reference it by name via `{ "$fn": "myCheck" }`.
2. If you have legitimate compound filters deeper than 16 levels, flatten them. Real filters almost never need more than 4-5 levels of nesting.

### 9. `Collection.database` property removed

The back-reference from a Collection instance to its owning Skalex instance is gone. It was an internal-only implementation detail but technically observable.

#### Before

```js
const users = db.useCollection("users");
const owner = users.database; // worked, returned the db
```

#### After

```js
const users = db.useCollection("users");
// users.database is undefined - hold a reference to `db` directly
```

#### Migration steps

Replace any `collection.database.*` access with a direct reference to the `db` instance you already have in scope.

### 10. `applyUpdate()` silently ignores `updatedAt`

User-supplied `updatedAt` values in an update descriptor are now discarded. Skalex always sets `updatedAt` to the current time on every successful update, matching how `_id` and `createdAt` were already system-managed.

#### Before

```js
await users.updateOne({ _id }, { $set: { name: "new", updatedAt: someTime } });
// someTime was accepted and written
```

#### After

```js
await users.updateOne({ _id }, { $set: { name: "new" } });
// updatedAt is set to Date.now() regardless of what you passed
```

#### Migration steps

Remove any `updatedAt` writes from your update payloads. If you need a user-controlled timestamp, use a different field name (e.g. `lastEditedAt`).

### 11. `createLLMAdapter()` throws on unknown providers

```js
// Before: returned null silently, db.ask() broke with no clue why
const llm = createLLMAdapter({ provider: "opanai", model: "gpt-4" });

// After: throws at construction
// AdapterError: ERR_SKALEX_ADAPTER_UNKNOWN_PROVIDER
```

#### Migration steps

Fix any typos in the `provider` string. Known providers are `"openai"` and `"anthropic"`. Passing a valid provider with no `model` still returns `null` (unchanged from alpha.2).

### 12. `deferredEffectErrors` constructor option is validated

Passing an invalid string to the new `deferredEffectErrors` config (e.g. `"warning"` instead of `"warn"`) throws `ValidationError` with `ERR_SKALEX_VALIDATION_DEFERRED_EFFECT_ERRORS` at construction time. Valid values are exactly `"throw"`, `"warn"`, and `"ignore"`. The same validation applies to the per-transaction override.

---

## v3 → v4

v4 is a major release that fundamentally shifts Skalex from a general-purpose local document store to an AI-first, isomorphic, zero-dependency database. The core API is largely preserved but several conventions have changed. Work through each section below before upgrading.

---

## 1. Node.js ≥ 18 Required

v4 uses `globalThis.crypto.subtle` for AES-256-GCM encryption and a runtime-aware ID generator that uses `crypto.randomBytes` on Node.js/Bun/Deno and falls back to `globalThis.crypto.getRandomValues` in the browser. The Node.js path requires Node.js 18 or later.

```bash
node --version  # must be >= 18.0.0
```

---

## 2. Sort Direction Convention

Sort direction now follows the MongoDB standard: `1` for ascending, `-1` for descending.

### Before (v3)

```js
await products.find({}, { sort: { price: "asc" } });
await products.find({}, { sort: { price: "desc" } });
```

### After (v4)

```js
await products.find({}, { sort: { price:  1 } }); // ascending
await products.find({}, { sort: { price: -1 } }); // descending
```

### Migration Steps

Replace all string sort directions with numeric equivalents across every `find()` call site.

### Additional Note: `insertOne` now sets `updatedAt`

Documents created with `insertOne` and `insertMany` now include an `updatedAt` field equal to `createdAt` at creation time. This is not a breaking change but may affect code that checks for the absence of `updatedAt`.

---

## 3. CSV Import Removed

`db.import()` no longer accepts a `format` parameter and no longer supports CSV files. The previous CSV parser split on commas without handling quoted fields, which meant any value containing a comma was silently corrupted. Round-trips with `collection.export({ format: "csv" })` produced incorrect data.

### Before (v3)

```js
await db.import("./data/users.csv", "csv");
```

### After (v4)

CSV import is not supported. Use JSON as the interchange format instead:

```js
// Export from your old source as JSON, then import:
await db.import("./data/users.json");
```

### Migration Steps

1. Export any existing CSV data to JSON before upgrading. If your data originated from `collection.export({ format: "csv" })`, re-export it as JSON first:

```js
// Run this against your v3 database before upgrading
await collection.export({}, { format: "json", name: "users" });
```

2. Replace every `db.import(path, "csv")` call with `db.import(path)` pointing at the JSON file.
3. `collection.export({ format: "csv" })` still works for exporting - only import of CSV was removed.
