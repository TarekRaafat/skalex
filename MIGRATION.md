# Skalex v3 → v4 Migration Guide

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
3. `collection.export({ format: "csv" })` still works for exporting  -  only import of CSV was removed.
