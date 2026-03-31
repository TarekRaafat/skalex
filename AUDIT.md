# Skalex Phase 0 Audit Log

Every fix applied during the Phase 0 code audit, with what was wrong, what changed, and line references (before -> after).

---

## Section 1: P0: Critical Bugs

### FIX-01: `findOne()` returned raw document instead of projected `newItem`

- **What was wrong:** `findOne()` built a `newItem` object with populate/select applied, then returned `item` (the raw document) instead of `newItem`. All projection and population was silently discarded.
- **What changed:** Changed `return item` to `return newItem` in `findOne()`.
- **File:** `src/collection.js`: was line 222, now line 221.

### FIX-02: `matchesFilter()` short-circuited on first key; AND logic broken

- **What was wrong:** Multi-condition filters like `{ role: 'admin', age: 30 }` only evaluated the first key and returned immediately. `$in`/`$nin` operators were inverted (`itemValue.includes(filterValue.$in)` instead of `filterValue.$in.includes(itemValue)`). Nested key traversal crashed on null intermediates and skipped falsy values (0, "", false).
- **What changed:** Complete rewrite of `matchesFilter()`. All conditions now return `false` on failure (AND semantics). `$in`/`$nin` corrected. Nested traversal uses `reduce` with null guard. Added support for RegExp as direct filter value.
- **File:** `src/collection.js`: was lines 375-438, now lines 369-413.

### FIX-03: `applyUpdate()`: `$inc` and `$push` never wrote back to `item[field]`

- **What was wrong:** `$inc` and `$push` operated on a local `itemValue` variable (a copy), never writing the result back to `item[field]`. The `updatedAt` timestamp was set inside the field loop (once per field instead of once per update). `Object.assign(item, item)` was a dead no-op.
- **What changed:** `$inc` now writes directly to `item[field]`. `$push` operates directly on `item[field]`. Removed dead `Object.assign(item, item)`. Moved `updatedAt` and `_index.set()` outside the field loop. Also rewrote `updateOne()` and `updateMany()` to find raw documents directly rather than through `findOne()`/`find()` which return projected copies.
- **File:** `src/collection.js`: was lines 144-180, now lines 146-169. `updateOne` now lines 84-112. `updateMany` now lines 122-138.

### FIX-04: `isSaving` was database-level; concurrent saves of different collections silently dropped

- **What was wrong:** A single `this.isSaving` flag on the Skalex instance meant that if collection A was saving, collection B's save was silently skipped. The flag was also not reset on errors that escaped both try/catch blocks.
- **What changed:** Removed database-level `isSaving`. Added `isSaving: false` to each collection's data object in `createCollection()` and `loadData()`. `saveData()` now checks/sets per-collection `isSaving`. Uses `finally` block to guarantee reset.
- **File:** `src/index.js`: removed old line 43 (`this.isSaving`). Per-collection flag at lines 112, 144. `saveData()` rewritten at lines 169-209.

### FIX-05: `writeFile()` double-serialised JSON; files written as string-within-a-string

- **What was wrong:** `saveData()` called `JSON.stringify()` on the data, then `writeFile()` called `JSON.stringify()` again, producing a double-encoded file. On read, `JSON.parse()` returned a string instead of an object.
- **What changed:** Removed `JSON.stringify(data)` from `writeFile()`. Data is now written as-is (already stringified by caller for save, or plain text for exports).
- **File:** `src/filesys.js`: was line 92, now lines 91-95.

---

## Section 2: P0: Logic Errors

### FIX-06: `findOne()` ignored the `_id` Map index; O(2n) instead of O(1)

- **What was wrong:** `findOne()` called `findIndex()` (full array scan), then iterated the array again. The `_id` Map index was never consulted.
- **What changed:** Added fast-path: when `filter._id` is present, lookup via `this._index.get(filter._id)` (O(1)). Falls back to linear scan only when `_id` is not in the filter.
- **File:** `src/collection.js`: was lines 193-228, now lines 179-222.

### FIX-07: Nested key traversal crashed on null/undefined intermediates

- **What was wrong:** The nested key loop used `if (itemValue[nestedKey])` which crashed on null/undefined and skipped falsy values.
- **What changed:** Resolved by FIX-02 rewrite using `keys.reduce((obj, k) => (obj != null ? obj[k] : undefined), item)`.
- **File:** `src/collection.js`: covered in `matchesFilter()` at lines 385-386.

### FIX-08: `$in`/`$nin` operators were semantically inverted and crashed on non-arrays

- **What was wrong:** `$in` used `itemValue.includes(filterValue.$in)`, which is backwards (item value is a scalar, not an array). `$nin` had the same inversion.
- **What changed:** Resolved by FIX-02 rewrite. Now `filterValue.$in.includes(itemValue)` and `filterValue.$nin.includes(itemValue)`.
- **File:** `src/collection.js`: covered in `matchesFilter()` at lines 400-401.

---

## Section 3: P1: Architectural Anti-patterns

### FIX-09: `collection.js` imported native `fs` and `path`; breaks non-Node environments

- **What was wrong:** `collection.js` imported Node's `fs` and `path` modules and used `fs.writeFileSync()` directly in `export()`, bypassing the storage adapter abstraction.
- **What changed:** Removed `require("fs")`, `require("path")`, and `require("./filesys")` imports. Rewrote `export()` to use `this.database.fs` (the storage adapter) for `checkDir()`, `writeFile()`, and `join()`. CSV export now properly quotes values containing commas.
- **File:** `src/collection.js`: removed lines 1-4. `export()` rewritten at lines 439-475.

### FIX-10: `useCollection()` created a new `Collection` instance every call

- **What was wrong:** Each call to `db.useCollection('users')` returned a new `Collection` object. State attached to one instance was invisible to the other.
- **What changed:** Added `this._collectionInstances = {}` cache in constructor. `useCollection()` now returns cached instance if one exists, or creates and caches a new one. Cache is cleared in `disconnect()`.
- **File:** `src/index.js`: constructor line 39. `useCollection()` at lines 85-100. `disconnect()` line 69.

### FIX-11: `Collection` held direct mutable references to `data` and `index`

- **What was wrong:** `this.data` and `this.index` were direct references to the underlying store, allowing external code to bypass all validation and safety checks.
- **What changed:** Constructor now stores `this._store = collectionData`. Added `_data` getter/setter and `_index` getter that access `_store.data` and `_store.index`. All internal references updated from `this.data` to `this._data` and `this.index` to `this._index`. Public `.data` and `.index` are no longer exposed.
- **File:** `src/collection.js`: constructor at lines 13-17. Accessors at lines 19-21.

---

## Section 4: P1: API Inconsistencies

### FIX-12: Inconsistent return shapes across CRUD operations

- **What was wrong:** `insertOne()`, `updateOne()`, and `deleteOne()` returned raw documents. `updateMany()` returned bare `[]` when no matches found. Mixed return shapes made the API unpredictable.
- **What changed:** Single-document operations now return `{ data: document }`. Multi-document operations consistently return `{ docs: [...] }`. `updateMany` returns `{ docs: [] }` instead of bare `[]`.
- **File:** `src/collection.js`: `insertOne` line 45, `updateOne` line 108, `deleteOne` line 328, `updateMany` line 137.

### FIX-13: `insertOne` missing `updatedAt` / `applyUpdate` set `updatedAt` in wrong scope

- **What was wrong:** `insertOne` did not set `updatedAt` on new documents. `applyUpdate` set `updatedAt` inside the field loop, setting it once per field instead of once per update call.
- **What changed:** Added `updatedAt: new Date()` to `insertOne` and `insertMany` document templates. `applyUpdate` now sets `updatedAt` once, outside the field loop (was fixed as part of FIX-03).
- **File:** `src/collection.js`: `insertOne` line 34, `insertMany` line 59, `applyUpdate` line 165.

---

## Section 5: P1: TypeScript Definitions

### FIX-14: `index.d.ts` rewritten from scratch

- **What was wrong:** Old type definitions referenced non-existent method `exportToCSV`, had wrong constructor signature (`dataDirectory: string` instead of config object), and defined phantom `save()` methods on return interfaces (`InsertRecord`, `UpdateRecord`, `DeleteRecord`).
- **What changed:** Complete rewrite. New file defines correct interfaces: `SkalexConfig`, `FindOptions`, `FindResult`, `SingleResult`, `ManyResult`, `ExportOptions`. `Collection` class is generic. `Skalex` constructor accepts optional `SkalexConfig`. All method signatures match the actual implementation.
- **File:** `src/index.d.ts`: entire file replaced (was 72 lines, now 69 lines).

---

## Section 6: P2: Code Quality

### FIX-15: `filesys.js` class named `fs`; shadowed Node built-in

- **What was wrong:** The class was named `fs`, shadowing Node's built-in `fs` module name.
- **What changed:** Renamed class from `fs` to `FileSystem`. Updated export and import in `index.js`.
- **File:** `src/filesys.js` lines 5, 130. `src/index.js` lines 3, 18.

### FIX-16: `generateUniqueId()` used `Math.random()`; collision risk

- **What was wrong:** Used `Math.floor(Math.random() * 9000000000)` which is not cryptographically secure and has higher collision probability at high insert rates.
- **What changed:** Now uses `crypto.randomBytes(8)` (Node) with fallback to `crypto.getRandomValues` (browser). Output is hex-encoded timestamp + random bytes, truncated to 24 characters.
- **File:** `src/utils.js`: was lines 5-17, now lines 5-19.

### FIX-17: `loadData()` swallowed all file errors silently

- **What was wrong:** All errors during file loading were caught and logged identically, whether the file didn't exist (expected) or was corrupt (unexpected). Corrupt data was silently lost.
- **What changed:** `ENOENT` errors are silently skipped (normal on first run). All other errors log a `WARNING` message identifying the filename and error, making corrupt files visible.
- **File:** `src/index.js`: was lines 141-143, now lines 147-153.

### FIX-18: `export()` and `saveData()` swallowed errors; callers could not detect failure

- **What was wrong:** Both catch blocks logged the error but did not re-throw. Callers received `undefined` whether the operation succeeded or failed.
- **What changed:** Added `throw error` after logging in both `export()` (collection.js) and `saveData()` (index.js).
- **File:** `src/collection.js` line 473. `src/index.js` line 194.

### FIX-19: CJS-only module; ESM imports fail

- **What was wrong:** No `exports` map in `package.json`. `engines` was set to `>=10.0.0` despite requiring features from newer Node versions.
- **What changed:** Added `module`, `exports` map with `require`/`import`/`default` entries. Updated `engines` to `>=18.0.0`.
- **File:** `package.json`: added `module` and `exports` fields, updated `engines`.
