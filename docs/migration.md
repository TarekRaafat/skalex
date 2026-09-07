# Upgrade to 4.0.0-alpha.7

These instructions apply to manual upgrades and upgrades assisted by an LLM. Use the [complete migration history](https://github.com/TarekRaafat/skalex/blob/master/MIGRATION.md) as the authoritative reference for version-specific changes.

## Choose your starting version

| Installed version | Required reading |
|---|---|
| 4.0.0-alpha.6 | Alpha.7 checklist below and the alpha.7 section of the migration history |
| Earlier v4 prerelease | Every intervening migration section in chronological order, then the alpha.7 checklist |
| v3 | The v3-to-v4 section, intervening prerelease changes, then the alpha.7 checklist |

Do not infer the installed version from an import statement. Check the application lockfile and installed package metadata. An exact version pin makes the upgrade reproducible.

## Before changing dependencies

1. Record the runtime, storage adapter, serialization/compression settings and encryption configuration.
2. Stop all writers before copying persistent storage. Preserve the complete storage set, including metadata and changelog collections, with its encryption key available separately.
3. Test the upgrade on a copy of that storage in an isolated application instance. Do not run old and new writers against the same directory or database.
4. Record the application's transaction callbacks, migration callbacks, HTTP MCP configuration and retry behavior.

Alpha.7 does not change the collection payload format. Local qualification covers alpha.6 JSON and gz filesystem data, with and without encryption, on Node and Bun. That evidence does not certify every adapter, runtime version or application schema.

## Update the application

Pin the target version in the application:

```sh
npm install skalex@4.0.0-alpha.7
```

Review the dependency and lockfile diff. Preserve storage paths, keys and adapter options.

| Existing usage | Alpha.7 action |
|---|---|
| Full Skalex type on a transaction or migration callback | Use TransactionHandle or a capability subset |
| tx.saveData() | Remove it and let transaction commit save owned writes |
| tx.seed(fixtures) | Use owned collection inserts for simple fixtures. Review reset and retry semantics explicitly |
| tx lifecycle, import, historical restore or inspection calls | Move outside the callback only when doing so preserves application semantics |
| Collection watch/export through a transaction handle | Use ordinary handles outside the callback |
| Captured transaction handles or unawaited writes | Await owned operations inside the callback and reacquire ordinary handles afterward |
| Redefining an existing collection through tx.createCollection | Define the schema before the transaction |
| Browser MCP requests | Configure an exact allowedOrigin and the trusted backend Host |
| Deployment copying only dist for MCP | Deploy the installed package including the lazy HTTP transport, tool module and shared error module |
| Editing nested read results locally | Request clone: true or treat default shared values as read-only |

Do not replace tx.saveData() with db.saveData() inside the callback. Do not move a mutation outside a transaction merely to bypass a capability error. If the old operation's semantics cannot be preserved with allowed capabilities, stop and explain the required application decision.

Default reads remain shallow. clone:true is optional and can reject uncloneable values. A failed upsertMany may retain and finalize completed items, so inspect applied state before retrying. Transactions provide owned-write rollback, not isolated reads or universal disk atomicity.

### Collection handles and definitions

Ordinary collection and memory handles expire after disconnect. An ordinary handle observing a transaction-created collection also expires if rollback removes that collection. Reset seeding preserves the current tracked handle. Reacquire them with useCollection() or useMemory() before subsequent operations. Stale collection access throws ValidationError with ERR_SKALEX_VALIDATION_STALE_COLLECTION and details.collection. Cached ordinary handles remain valid through loadData(). Existing watch subscriptions retain their prior lifetime behavior. createCollection() rejects an existing definition with ERR_SKALEX_PERSISTENCE_COLLECTION_EXISTS. Define schemas before connect(), and use useCollection() to access existing data. Rename validates both names before changing state. Ordinary saves reject transaction-locked targets with ERR_SKALEX_TX_COLLECTION_LOCKED, including when ownership changes while queued. loadData() and disconnect() reject during an active transaction with ERR_SKALEX_TX_DIRECT_ACCESS. Rename and reset seeding reject locked targets. Saving independent unlocked collections remains supported.


### Imports, query options and cached translations

Adapter constructors are runtime exports of skalex/connectors and its subpaths. Their root names are type-only, as are Memory, ChangeLog, SkalexMCPServer and the named Skalex type. Import the database constructor as the default export. Obtain memory, changelog and MCP instances through their database factories. findOne accepts populate, select, includeDeleted and clone, not sort/page/limit/session. Use find for sorting and pagination. Compound index declarations accept arrays of field names.

Natural-language query caches now persist the complete collection/schema/query identity. Legacy hash-only cache records are ignored and translations regenerate on demand. This may cause an additional model call after upgrade. CSV export uses the union of fields in first-seen order and writes empty cells for missing fields, preserving column alignment.

## Verify before rollout

- Compile the application, including transaction and migration callback types.
- Run CRUD and indexed queries against the copied dataset.
- Run each pending migration and reconnect to verify its data and applied-version record.
- Exercise transaction success and callback failure, including relevant hooks.
- Verify HTTP MCP access from intended clients and rejection of unintended origins.
- Save, disconnect and reopen with the same adapter and encryption configuration.
- Inspect incomplete-flush warnings before acknowledging them. Never auto-acknowledge as an upgrade step.
- Preserve legacy temporary-looking files and investigate payload-name mismatches. Never bulk-delete files containing .tmp.
- Treat ERR_SKALEX_MUTATION_RECOVERY as a failed instance. Stop using it and reopen verified storage rather than clearing internal flags.

If validation fails, stop the rollout. Restore the verified pre-upgrade backup with the previous application only after stopping new writers. Do not assume downgrading the dependency reverses application migrations.

## Instructions for an LLM-assisted upgrade

Give the assistant this page, the complete migration history, the application manifest/lockfile and relevant callback/adapter configuration. Do not paste production encryption keys or credentials.

```text
Upgrade this application to Skalex 4.0.0-alpha.7 using the documented migration path.
First identify the installed version, runtime, adapter and all intervening changes.
Preserve application semantics and storage configuration.
Apply callback and HTTP changes using the migration table.
Do not weaken security settings or move writes outside transactions to silence errors.
Do not delete storage files, acknowledge flush warnings or reset recovery flags.
Use an isolated copy of persistent data for validation.
Report changed call sites, passing checks, untested cases and unresolved decisions.
Do not claim the upgrade is complete solely because compilation or installation passes.
```

Use the [worked examples](usage-examples.md#28-reuse-a-helper-inside-a-transaction-or-migration) for allowed callback patterns and [reference documentation](documentation.md) for precise error contracts.
