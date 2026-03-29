# Roadmap <!-- {docsify-ignore} -->

Future features & enhancements

---

#### Todo

- [ ] Automated backup & restore
- [ ] Plugins system for extending functionality
- [ ] Additional export formats (NDJSON, Parquet)
- [ ] IndexedDB adapter (browser persistent storage)
- [ ] D1 / Cloudflare Workers adapter
- [ ] Bun SQLite adapter
- [ ] LibSQL / Turso adapter
- [ ] Compound indexes (multi-field)
- [ ] Query explain / execution plan debug tool

#### Done

- [x] Dual ESM/CJS build (`dist/skalex.esm.js` + `dist/skalex.cjs.js`)
- [x] Full TypeScript definitions with generics and union types
- [x] Pluggable `StorageAdapter` interface
- [x] `FsAdapter` — atomic writes, gz/json format
- [x] `LocalStorageAdapter` — browser `localStorage` support
- [x] `EncryptedAdapter` — AES-256-GCM at-rest encryption (Node ≥18, Bun, Deno, browser)
- [x] Secondary field indexes — O(1) lookups via `IndexEngine`
- [x] Unique index constraints
- [x] Schema validation (`type`, `required`, `unique`, `enum`)
- [x] TTL documents — `_expiresAt` + connect-time sweep
- [x] Versioned migrations with `_meta` tracking
- [x] `db.transaction()` — snapshot + commit/rollback
- [x] `db.seed()` — fixture seeding with optional reset
- [x] `db.dump()` — full data snapshot
- [x] `db.inspect()` — collection metadata
- [x] `db.namespace()` — scoped sub-instances (inherits `ai` + `encrypt`)
- [x] `db.import()` — JSON/CSV file import
- [x] `db.ask()` — natural language → structured filter via LLM; results cached
- [x] `db.schema()` — declared or inferred `{ field: type }` schema
- [x] `db.useMemory()` — episodic agent memory (`remember`, `recall`, `context`, `compress`)
- [x] `db.changelog()` / `db.restore()` — append-only mutation log + point-in-time restore
- [x] `db.stats()` — count, estimated size, average doc size per collection
- [x] `db.slowQueries()` — slow query log with configurable threshold and ring buffer
- [x] `db.mcp()` — MCP server (stdio + HTTP/SSE) for Claude Desktop, Cursor, and any MCP client
- [x] `collection.upsert()` — update-or-insert
- [x] `insertOne({ ifNotExists })` — safe conditional insert
- [x] `collection.count / sum / avg / groupBy` — aggregation with filter + dot-notation
- [x] `collection.watch()` — reactive mutation observer (callback + AsyncIterableIterator)
- [x] `session` option on all mutations — audit trail via changelog
- [x] `debug` config option
- [x] Custom `adapter` config option
- [x] `EmbeddingAdapter` interface — pluggable embedding backends
- [x] `OpenAIEmbeddingAdapter` — OpenAI `text-embedding-3-small` (and any model override)
- [x] `OllamaEmbeddingAdapter` — local embeddings via Ollama
- [x] `AIAdapter` interface — pluggable language model backends
- [x] `OpenAIAIAdapter` — chat completions, default `gpt-4o-mini`
- [x] `AnthropicAIAdapter` — messages API, default `claude-haiku-4-5`
- [x] `OllamaAIAdapter` — local `/api/generate`, default `llama3.2`
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
