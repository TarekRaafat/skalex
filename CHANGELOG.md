# Changelog

All notable changes to Skalex are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [4.0.0] — 2026-03-29

> **Breaking changes** — see `MIGRATION.md` for upgrade instructions.

### Changed (breaking)
- `insertOne()` now returns `{ data: document }` instead of the raw document
- `updateOne()` now returns `{ data: document }` instead of the raw document
- `deleteOne()` now returns `{ data: document }` instead of the raw document
- `updateMany()` now always returns `{ docs: [] }` when no matches found — never bare `[]`
- Minimum Node.js version raised to `>=18.0.0`

### Added
- `updatedAt` field set at creation time by `insertOne` and `insertMany`
- `exports` map in `package.json` for ESM/CJS dual-import support (`module` field added)
- `CHANGELOG.md` (this file)
- `AUDIT.md` — Phase 0 audit log documenting all 19 fixes with before/after line references
- `MIGRATION.md` — upgrade guide for v3 → v4 breaking changes
- Test suite under `tests/` covering all Phase 0 fixes (30 tests)

### Fixed
- `findOne()` returned the raw document instead of the projected `newItem` — populate and select options were silently discarded
- `matchesFilter()` short-circuited on the first key — multi-condition AND filters never evaluated beyond the first condition
- `$in` and `$nin` operators were semantically inverted (`itemValue.includes(filterValue.$in)` instead of `filterValue.$in.includes(itemValue)`) and crashed on non-array field values
- `$inc` in `applyUpdate()` modified a local variable and never wrote back — increments were silently lost
- `$push` in `applyUpdate()` same write-back bug — pushed to a local copy
- `applyUpdate()` set `updatedAt` inside the field loop — once per field instead of once per update call
- `applyUpdate()` contained dead `Object.assign(item, item)` no-op (removed)
- `isSaving` was a single database-level flag — if collection A was saving, collection B's save was silently skipped
- `isSaving` was not reset via `finally` — an unhandled error could lock the database permanently
- `writeFile()` called `JSON.stringify()` on data that was already a JSON string — produced double-encoded files
- `findOne()` called `findIndex()` (O(n) scan) then iterated the array again (O(n)) even for `_id` lookups — now uses Map index (O(1))
- Nested key traversal in `matchesFilter()` crashed on null/undefined intermediate values
- Nested key traversal used `if (itemValue[key])` — falsily skipped values of `0`, `""`, `false`
- `collection.js` imported native `fs` and `path` modules — broke non-Node environments and bypassed the storage adapter
- `useCollection()` created a new `Collection` instance on every call — state could not be reliably attached to a collection
- `loadData()` silently swallowed all errors — corrupt files were indistinguishable from missing files
- `export()` caught and logged errors but did not re-throw — callers could not detect failure
- `saveData()` same silent-error pattern

### Updated
- `Collection` internal state renamed: `this.data` → `this._data`, `this.index` → `this._index`; accessed via `_store` reference with getter/setter
- `useCollection()` now caches `Collection` instances and returns the same object for the same collection name; cache cleared on `disconnect()`
- `export()` now routes through `this.database.fs` (storage adapter) instead of calling `fs.writeFileSync()` directly
- `generateUniqueId()` now uses `crypto.randomBytes(8)` (Node) with fallback to `crypto.getRandomValues` (browser) instead of `Math.random()`
- `filesys.js` class renamed from `fs` to `FileSystem` — no longer shadows the Node built-in
- `src/index.d.ts` completely rewritten: correct `SkalexConfig` constructor, accurate return types (`SingleResult`, `ManyResult`, `FindResult`), removed phantom `exportToCSV` and `save()` methods

---

## [3.2.5] — prior

- Fixed: Files Read/Write compression handling

## [3.2.4] — prior

- Fixed: Empty filter object handling

## [3.2.3] — prior

- Fixed: Empty filter object handling

## [3.2.2] — prior

- Fixed: `Collection` reference

## [3.2.1] — prior

- Fixed: `updateOne` & `updateMany` methods issue
- Updated: `update` methods for optimizations

## [3.2.0] — prior

- Added: Complete isolated and improved `fs` module
- Updated: `loadData` & `saveData` methods
- Fixed: `findOne` method broken options
- Fixed: `find` method find all use-case

## [3.1.0] — prior

- Added: `$inc` and `$push` operators to `updateOne` and `updateMany`
- Fixed: `saveData` format according to the set config data format

## [3.0.1] — prior

- Fixed: Broken data directory `path` reference

## [3.0.0] — prior

- Breaking changes — see docs/release-notes.md for details
