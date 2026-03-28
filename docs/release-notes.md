# Release Notes

Find release notes/changelog and guides on versioning guidelines

---

## Versioning

---

For transparency and insight into the release cycle, releases will be numbered
with the following format:

`<major>.<minor>.<patch>`

And constructed with the following guidelines:

- Breaking backwards compatibility bumps the major
- New additions without breaking backwards compatibility bumps the minor
- Bug fixes and misc changes bump the patch

For more information on semantic versioning, please visit <http://semver.org/>.

- Release flags:
  - `[Experimental]`: Under testing and might be deprecated at any point
  - `[Deprecated]`: Not developed / supported anymore, might be removed at any point
  - `[Removed]`: Completely gone, no longer exists
  - `[Changed]`: Breaking change in the API or the core library
  - `[Updated]`: Non-breaking change in the API or the core library
  - `[Fixed]`: Bug or Issue that was fixed and no longer exists
  - `[Added]`: New feature

---

## Releases

---

### v4.0.0 ✨

> Disclaimer!
>
> This release has breaking changes. See `MIGRATION.md` for upgrade instructions.

- 🌀 Changed: `insertOne`, `updateOne`, `deleteOne` now return `{ data: document }` instead of the raw document
- 🌀 Changed: `updateMany` now always returns `{ docs: [] }` instead of bare `[]` when no matches found
- 🌀 Changed: `engines` minimum Node.js version raised to `>=18.0.0`
- ➕ Added: `updatedAt` field set on `insertOne` and `insertMany` documents at creation time
- ➕ Added: `exports` map in `package.json` for ESM/CJS dual-import support
- ➕ Added: `CHANGELOG.md` at repo root
- ➕ Added: `AUDIT.md` — Phase 0 audit log documenting all 19 fixes
- ➕ Added: `MIGRATION.md` — upgrade guide for v3 → v4 breaking changes
- ➕ Added: Test suite (`tests/`) covering all Phase 0 fixes
- 🔧 Fixed: `findOne()` was returning raw document instead of projected `newItem` — populate/select were silently discarded
- 🔧 Fixed: `matchesFilter()` short-circuited on first key — multi-condition AND filters did not work
- 🔧 Fixed: `$in` and `$nin` operators were semantically inverted and crashed on non-arrays
- 🔧 Fixed: `$inc` and `$push` in `applyUpdate()` modified a local variable and never wrote back to `item[field]`
- 🔧 Fixed: `isSaving` was a single database-level flag — concurrent saves of different collections were silently dropped
- 🔧 Fixed: `writeFile()` double-serialised JSON — files were written as a string-within-a-string
- 🔧 Fixed: `findOne()` ignored the `_id` Map index — performed O(2n) scan instead of O(1) lookup
- 🔧 Fixed: Nested key traversal crashed on null/undefined intermediate values
- 🔧 Fixed: `insertOne` did not set `updatedAt`; `applyUpdate` set `updatedAt` inside the field loop
- 🔧 Fixed: `export()` and `saveData()` swallowed errors — callers could not detect failure
- 🔧 Fixed: `loadData()` silently swallowed corrupt file errors with no distinction from missing files
- 🎛️ Updated: `Collection` internal references renamed `data`/`index` → `_data`/`_index` — encapsulation boundary established
- 🎛️ Updated: `useCollection()` now caches and returns the same `Collection` instance for a given name
- 🎛️ Updated: `export()` routes through the storage adapter — no more direct `fs`/`path` imports in `collection.js`
- 🎛️ Updated: `generateUniqueId()` now uses `crypto.randomBytes` (Node) / `crypto.getRandomValues` (browser)
- 🧹 Cleaned: `filesys.js` class renamed from `fs` to `FileSystem` to avoid shadowing Node built-in
- 📝 Rewritten: `src/index.d.ts` — correct constructor signature, accurate return types, no phantom methods

---

### v3.2.5 ✨

- 🔧 Fixed: Files `Read/Write` compression handling

---

### v3.2.4

- 🔧 Fixed: Empty filter object handling

---

### v3.2.3

- 🔧 Fixed: Empty filter object handling

---

### v3.2.2

- 🔧 Fixed: `Collection` reference

---

### v3.2.1

- 🔧 Fixed: `updateOne` & `updateMany` methods issue
- 🎛️ Updated: `update` methods for optimizations

---

### v3.2.0

- ➕ Added: Complete isolated and improved `fs` module
- 🎛️ Updated: `loadData` & `saveData` methods
- 🎛️ Updated: `utils` by separating `fs` related methods
- 🎛️ Updated: `logger` for better error logging
- 🔧 Fixed: `findOne` method broken options
- 🔧 Fixed: `find` method find all use-case
- 🧹 Cleaned: all methods for better handling

---

### v3.1.0

- ➕ Added: `$inc` and `$push` operators to `updateOne` and `updateMany` methods
- 🔧 Fixed: `saveData` format according to the set `config` data format

---

### v3.0.1

- 🔧 Fixed: Broken data directory `path` reference

---

### v3.0.0

> Disclaimer!
>
> 1- This release has several breaking changes, so kindly check all the below changes before update.
>
> 2- The documentation is currently out of sync and the update will follow later.

- ➕ Added: Find nested object values support `find({ "object.key": "value" })`
- ➕ Added: Setting collection `export` destination directory
- 🌀 Changed: Setting database files directory instead of `string` to `object` key of `{ path: "./.db" }`
- 🌀 Changed: Saved default data format from `JSON` files to compressed `gz` files
- 🌀 Changed: Operations `save` from method to an option for `insert` `update` `delete` operations
- 🌀 Changed: `exportToCSV` method name to `export`
- 🌀 Changed: `find` operation returns all docs by default, setting `limit` for pagination
- 🎛️ Updated: Collection `export` default destination to `exports` directory under the set `dataDirectory`
- 🎛️ Updated: All `many` operations output to object key `{ docs }`
- 🎛️ Updated: Operations `save` to be more efficient by saving used collection instead of all
- 🎛️ Updated: `population` for dynamic key population
- 🎛️ Updated: `loadData` and `saveData` methods for improved concurrent file Reads/Writes
- 🎛️ Updated: Files & Directory handling to ensure consistent path formatting across different operating systems
- 🔧 Fixed: Updating index map for `updateOne` and `updateMany` operations
- 🔧 Fixed: `updateMany` to save inserted updates
- 🔧 Fixed: Setting `isSaving` flag in error cases while saving collections
- 🧹 Cleaned: `matchesFilter` method for better readability

---

### v2.0.0

- ➕ Added: Pagination info on the `find` method return
- ➕ Added: Custom `logger` utility function
- 🎛️ Updated: `generateUniqueId` method to generate better and more unique IDs
- 🎛️ Updated: `createdAt` to be eligible for modification on creation
- 🎛️ Updated: `updatedAt` to be eligible for modification on update
- 🎛️ Updated: `saveData` to provide better performance without conflicts

---

### v1.4.1

- 🔧 Fixed: `saveData` method feedback was broken

---

### v1.4.0

- ➕ Added: `isSaving` attribute to check if there's saving in process
- 🎛️ Updated: `buildIndex` method to accept external index key
- 🔧 Fixed: `matchesFilter` validating `itemValue` before applying filter
- 🧹 Cleaned: `saveData` method and some house keeping

---

### v1.3.0

- ➕ Added: `$fn` custom function as a filtering option to the `find` method
- ➕ Added: `function` option to the `find` method
- 🧹 Cleaned: `Collection` class and some house keeping

---

### v1.2.0

- ➕ Added: `REGEX` filtering option to the `find` method
- ➕ Added: `Pagination` option to the `find` method
- ➕ Added: `Sorting` options to the `find` method
- 🧹 Cleaned: Project files and some house keeping

---

### v1.1.4

- 🔧 Fixed: Collection population of `find` method
- ➕ Added: Collection population to `findOne` method

---

### v1.1.3

- 🎛️ Updated: Library Documentation

---

### v1.1.2

- 🎛️ Updated: Library Documentation

---

### v1.1.1

- ➕ Added: Library Documentation
- ➕ Added: Comprehensive code comments

---

### v1.1.0

- ➕ Added: `useCollection` to select used collections or creating it if does not exist
- ➕ Added: Collections relations `one-to-one` and `one-to-many`
- ➕ Added:`population` function to populated linked collections
- ➕ Added: `select` function to select returned record values
- ➕ Added: `createdAt` and `updatedAt` values to each record
- 🧹 Cleaned: Project files and some house keeping

---

### v1.0.3

- 🔧 Fixed: NPM package

---

### v1.0.2

- 🔧 Fixed: NPM package

---

### v1.0.1

- 🔧 Fixed: Library reference

---

### v1.0.0

- Initial release
