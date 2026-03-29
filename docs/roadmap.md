# Roadmap <!-- {docsify-ignore} -->

Future features & enhancements

---

#### Todo

- [ ] Data aggregation (`$group`, `$sum`, `$avg`)
- [ ] Automated backup & restore
- [ ] Plugins system for extending functionality
- [ ] Additional export formats (NDJSON, Parquet)
- [ ] IndexedDB adapter (browser persistent storage)
- [ ] D1 / Cloudflare Workers adapter
- [ ] Compound indexes (multi-field)
- [ ] Change streams / event hooks (`on("insert", ...)`)
- [ ] Query explain / execution plan debug tool

#### In Progress

- [ ] Agent memory primitives (`useMemory`, `remember`, `recall`, `context`) — Phase 3
- [ ] Natural language queries (`db.ask()`) — Phase 3
- [ ] Encryption at rest (AES-256, Web Crypto) — Phase 3
- [ ] Change log & point-in-time restore — Phase 3

#### Done

- [x] Dual ESM/CJS build (`dist/skalex.esm.js` + `dist/skalex.cjs.js`)
- [x] Full TypeScript definitions with generics and union types
- [x] Pluggable `StorageAdapter` interface
- [x] `FsAdapter` — atomic writes, gz/json format
- [x] `LocalStorageAdapter` — browser `localStorage` support
- [x] Secondary field indexes — O(1) lookups via `IndexEngine`
- [x] Unique index constraints
- [x] Schema validation (`type`, `required`, `unique`, `enum`)
- [x] TTL documents — `_expiresAt` + connect-time sweep
- [x] Versioned migrations with `_meta` tracking
- [x] `db.transaction()` — snapshot + commit/rollback
- [x] `db.seed()` — fixture seeding with optional reset
- [x] `db.dump()` — full data snapshot
- [x] `db.inspect()` — collection metadata
- [x] `db.namespace()` — scoped sub-instances
- [x] `db.import()` — JSON/CSV file import
- [x] `collection.upsert()` — update-or-insert
- [x] `insertOne({ ifNotExists })` — safe conditional insert
- [x] `debug` config option
- [x] Custom `adapter` config option
- [x] `EmbeddingAdapter` interface — pluggable embedding backends
- [x] `OpenAIEmbeddingAdapter` — OpenAI `text-embedding-3-small` (and any model override)
- [x] `OllamaEmbeddingAdapter` — local embeddings via Ollama
- [x] Filter pre-sorter — indexes evaluated before regex/`$fn`
- [x] Full query operator support (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$fn`)
- [x] Dot-notation nested field queries
- [x] Atomic save (temp-file-then-rename)
- [x] Per-collection `isSaving` flag — concurrent saves no longer blocked
- [x] `crypto`-based unique ID generation
- [x] `$inc` and `$push` update operators
- [x] Sorting (`sort: { field: 1 | -1 }`)
- [x] Pagination (`page` + `limit`)
- [x] Data projection (`select`)
- [x] Collection population (`populate`)
- [x] Export to JSON/CSV
- [x] `createdAt` and `updatedAt` auto-fields
- [x] `useCollection()` singleton caching
- [x] Custom search methods (`$fn`, RegExp)
- [x] Release notes
- [x] Basic documentation
