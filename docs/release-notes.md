# Release Notes

Every release is documented in full in the [CHANGELOG](https://github.com/TarekRaafat/skalex/blob/master/CHANGELOG.md). This page explains the versioning conventions and release flags used throughout.

---

## 4.0.0-alpha.7 - 2026-09-07

Alpha.7 strengthens data safety, transaction ownership, query correctness and MCP request validation. Collection payload formats remain compatible with alpha.6.

Read the [upgrade checklist](migration.md) before changing an existing application. Transaction callbacks, collection-handle lifetime and MCP HTTP configuration require review.

### Breaking Changes

- **Transaction capabilities** - callbacks receive a restricted transaction handle. Await owned operations inside the callback, remove manual transaction saves and move unsupported operations only when application semantics permit.
- **Collection lifetime and definitions** - reacquire collection and memory handles after disconnect. Use useCollection() for existing collections instead of redefining them.
- **Persistence admission and restore** - conflicting saves and lifecycle operations reject during transactions. Historical restore events follow successful saving. A failed restore save leaves dirty restored memory.
- **MCP HTTP validation** - browser clients must configure allowed origins, and reverse proxies must send the trusted backend Host.
- **Package declarations** - import adapter constructors from connector entries and the database constructor from the default export. Root factory-only names are types. findOne options now match implemented behavior.

### Added

- **Detached reads** - request clone: true when returned nested values must be independent. Existing shallow defaults remain.
- **Incomplete-flush acknowledgement** - acknowledge an inspected and, where needed, repaired incomplete batch explicitly. Acknowledgement does not repair or save data.

### Fixed

- **Storage and authorization** - preserve legitimate temporary-looking collection files, validate stored collection names, normalize MCP collection names before authorization and reject untrusted HTTP requests before dispatch.
- **Mutation consistency** - enforce concurrent primary-ID uniqueness, validate batches before mutation, recover bounded synchronous document/index failures and finalize completed upsert items on later failure.
- **Transaction and persistence coordination** - prevent unrelated writes from borrowing ownership, order ordinary saves with transaction commits and preserve incomplete-flush detection.
- **Queries and memory** - correct ID operator matching, missing-indexed-field queries, sorting before projection, generated timestamps in strict schemas and compressed-memory embeddings.
- **Cache, exports and package identity** - use complete query-cache identities, align CSV columns and preserve error constructor identity across package entries within one realm.

### Performance and Size

- **Persistence tradeoff** - Ordinary saves now share an ordered queue with transaction commits to prevent older saves from overwriting newer committed data. Saving multiple collections, including during disconnect, may take longer. This is a persistence-ordering safeguard, not a claim of performance neutrality.

- Skip empty insert before-hooks and ordinary mutation after-hooks when no plugins are registered, while preserving deferred transaction hooks.
- Local plugin-free insert benchmarks improved on the preceding alpha.7 build. These results do not establish performance for embeddings, persistence or registered plugins.
- Core minified bundles remain within the unchanged 29500-byte gzip limit. MCP HTTP and tool modules load lazily and must remain available in deployed packages.

### Tests

- 1306 tests pass, with built-artifact smoke on Node, Bun, Deno and Chromium.
- Installed-consumer checks cover package imports, declarations and alpha.6 JSON/gzip migrations with and without encryption on Node and Bun. These checks do not certify every adapter or minimum runtime version.
- Transaction read isolation, arbitrary crash recovery and automatic repair are not added by this release.

## Versioning

Releases follow `<major>.<minor>.<patch>` ([Semantic Versioning](http://semver.org/)):

- Breaking backwards compatibility bumps the **major**
- New additions without breaking changes bump the **minor**
- Bug fixes and misc changes bump the **patch**

### Release flags

| Flag | Meaning |
|------|---------|
| `[Experimental]` | Under testing, may be deprecated at any point |
| `[Deprecated]` | No longer developed or supported, may be removed |
| `[Removed]` | Completely gone, no longer exists |
| `[Changed]` | Breaking change in the API or core library |
| `[Updated]` | Non-breaking change in the API or core library |
| `[Fixed]` | Bug or issue that was fixed |
| `[Added]` | New feature |

---

## Releases

The full release history is maintained in [`CHANGELOG.md`](https://github.com/TarekRaafat/skalex/blob/master/CHANGELOG.md) at the repository root.
