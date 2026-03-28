# Skalex v3 -> v4 Migration Guide

## Breaking Change: CRUD Return Shapes (FIX-12)

The return shapes of single-document CRUD operations have changed.

### Before (v3)

```js
const doc = await users.insertOne({ name: 'Alice' });
// doc = { _id: '...', name: 'Alice', createdAt: ... }

const updated = await users.updateOne({ name: 'Alice' }, { age: 30 });
// updated = { _id: '...', name: 'Alice', age: 30, ... }

const deleted = await users.deleteOne({ name: 'Alice' });
// deleted = { _id: '...', name: 'Alice', ... }
```

### After (v4)

```js
const { data: doc } = await users.insertOne({ name: 'Alice' });
// doc = { _id: '...', name: 'Alice', createdAt: ..., updatedAt: ... }

const { data: updated } = await users.updateOne({ name: 'Alice' }, { age: 30 });
// updated = { _id: '...', name: 'Alice', age: 30, ... }

const { data: deleted } = await users.deleteOne({ name: 'Alice' });
// deleted = { _id: '...', name: 'Alice', ... }
```

All single-document operations (`insertOne`, `updateOne`, `deleteOne`) now return `{ data: document }` instead of the raw document.

All multi-document operations (`insertMany`, `updateMany`, `deleteMany`, `find`) continue to return `{ docs: [...] }`. The change for `updateMany` is that it now always returns `{ docs: [] }` when no matches are found, instead of a bare `[]`.

### Migration Steps

1. Update all `insertOne` call sites to destructure: `const { data } = await collection.insertOne(...)` or access via `.data`.
2. Update all `updateOne` call sites similarly.
3. Update all `deleteOne` call sites similarly.
4. If you checked `updateMany` results against `[]`, check `result.docs.length === 0` instead.

### Additional Note: `insertOne` now sets `updatedAt`

Documents created with `insertOne` and `insertMany` now include an `updatedAt` field (set to the same value as `createdAt` at creation time). This is not a breaking change but may affect code that checks for the absence of `updatedAt` to determine if a document has been modified.
