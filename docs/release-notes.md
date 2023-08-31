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

### v3.2.3 ✨

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
