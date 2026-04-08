import Collection from "./engine/collection.js";
import { logger as _defaultLogger } from "./engine/utils.js";
import FsAdapter from "./connectors/storage/fs.js";
import MigrationEngine from "./engine/migrations.js";
import IndexEngine from "./engine/indexes.js";
import { parseSchema } from "./engine/validator.js";
import { sweep } from "./engine/ttl.js";
import { SkalexError, PersistenceError, TransactionError, AdapterError, ValidationError, UniqueConstraintError, QueryError } from "./engine/errors.js";
import PersistenceManager from "./engine/persistence.js";
import TransactionManager from "./engine/transaction.js";
import CollectionRegistry from "./engine/registry.js";
import { createEmbeddingAdapter, createLLMAdapter } from "./engine/adapters.js";
import EncryptedAdapter from "./connectors/storage/encrypted.js";
import Memory from "./features/memory.js";
import ChangeLog from "./features/changelog.js";
import { QueryCache, processLLMFilter, validateLLMFilter } from "./features/ask.js";
import EventBus from "./features/events.js";
import QueryLog from "./features/query-log.js";
import SessionStats from "./features/session-stats.js";
import PluginEngine from "./features/plugins.js";
import SkalexMCPServer from "./connectors/mcp/index.js";

/** Key used to store migration state in the _meta collection. */
const META_KEY = "migrations";

/**
 * BigInt- and Date-safe JSON serializer. Encodes BigInt values as tagged objects
 * and Date instances as tagged ISO strings so they survive the round-trip.
 * Uses `function` (not arrow) so `this` is the holder object - needed because
 * JSON.stringify calls Date.toJSON() before the replacer sees the value.
 * @param {any} value
 * @returns {string}
 */
const _serialize = (value) =>
  JSON.stringify(value, function (key, v) {
    const raw = this[key];
    if (raw instanceof Date) return { __skalex_date__: raw.toISOString() };
    if (typeof v === "bigint") return { __skalex_bigint__: v.toString() };
    return v;
  });

/**
 * Counterpart to `_serialize`. Revives tagged BigInt and Date objects.
 * @param {string} text
 * @returns {any}
 */
const _deserialize = (text) =>
  JSON.parse(text, (_, v) => {
    if (v && typeof v === "object") {
      if ("__skalex_bigint__" in v) return BigInt(v.__skalex_bigint__);
      if ("__skalex_date__" in v) return new Date(v.__skalex_date__);
    }
    return v;
  });

/**
 * Skalex  -  an in-process document database with file-system persistence.
 *
 * @example
 * const db = new Skalex({ path: "./.db" });
 * await db.connect();
 * const users = db.useCollection("users");
 * await users.insertOne({ name: "Alice" });
 */
class Skalex {
  /**
   * @param {object} [config]
   * @param {string}  [config.path="./.db"]  - Data directory path.
   * @param {string}  [config.format="gz"]   - "gz" (compressed) or "json".
   * @param {boolean} [config.debug=false]   - Log debug output.
   * @param {object}  [config.adapter]       - Custom StorageAdapter instance.
   * @param {object}  [config.ai]              - AI configuration (embedding + language model).
   * @param {string}  [config.ai.provider]     - "openai" | "anthropic" | "ollama"
   * @param {string}  [config.ai.apiKey]       - API key (OpenAI / Anthropic).
   * @param {string}  [config.ai.embedModel]   - Embedding model override (falls back to model).
   * @param {string}  [config.ai.model]        - Language model override.
   * @param {string}  [config.ai.host]         - Ollama server URL override.
   * @param {object}  [config.encrypt]             - Encryption configuration.
   * @param {string}  [config.encrypt.key]         - AES-256 key (64-char hex or 32-byte Uint8Array).
   * @param {object}  [config.slowQueryLog]              - Slow query log options.
   * @param {number}  [config.slowQueryLog.threshold]    - Duration threshold in ms. Default: 100.
   * @param {number}  [config.slowQueryLog.maxEntries]   - Max entries to keep. Default: 500.
   * @param {object}  [config.queryCache]                - Query cache options.
   * @param {number}  [config.queryCache.maxSize]        - Max cached entries. Default: 500.
   * @param {number}  [config.queryCache.ttl]            - Cache TTL in ms. Default: 0 (no expiry).
   * @param {object}  [config.memory]                    - Global agent memory options.
   * @param {number}  [config.memory.compressionThreshold] - Token threshold for auto-compress. Default: 8000.
   * @param {number}  [config.memory.maxEntries]         - Max memory entries before auto-compress. Default: none.
   * @param {Function} [config.logger]                   - Custom logger function (message, level) => void.
   * @param {object}  [config.llmAdapter]                - Pre-built LLM adapter instance (overrides ai).
   * @param {object}  [config.embeddingAdapter]          - Pre-built embedding adapter instance (overrides ai).
   * @param {number}  [config.regexMaxLength=500]        - Maximum allowed $regex pattern length in ask() filters.
   * @param {Function} [config.idGenerator]              - Custom document ID generator function. Default: built-in timestamp+random.
   * @param {Function} [config.serializer]               - Custom serializer for storage writes. Default: JSON.stringify.
   * @param {Function} [config.deserializer]             - Custom deserializer for storage reads. Default: JSON.parse.
   * @param {boolean} [config.autoSave=false]            - Automatically persist after every write without passing { save: true }.
   * @param {number}  [config.ttlSweepInterval]          - Interval in ms to periodically sweep expired TTL documents.
   */
  constructor({ path = "./.db", format = "gz", debug = false, adapter, ai, encrypt, slowQueryLog, queryCache, memory, logger, plugins, llmAdapter, embeddingAdapter, regexMaxLength, idGenerator, serializer, deserializer, autoSave, ttlSweepInterval } = {}) {
    this.dataDirectory = path;
    this.dataFormat = format;
    this.debug = debug;

    // Expose error types as static properties for CJS/UMD consumers.
    // Uses direct references (not a namespace) so tree-shaking cannot remove
    // them — these bindings are already used in throw statements throughout
    // the engine, so Rollup considers them live.
    if (!Skalex._errorsAttached) {
      Skalex.SkalexError = SkalexError;
      Skalex.ValidationError = ValidationError;
      Skalex.UniqueConstraintError = UniqueConstraintError;
      Skalex.TransactionError = TransactionError;
      Skalex.PersistenceError = PersistenceError;
      Skalex.AdapterError = AdapterError;
      Skalex.QueryError = QueryError;
      Skalex._errorsAttached = true;
    }

    this._adapterConfig = adapter ?? null; // track whether a custom adapter was explicitly provided
    let fs = adapter || new FsAdapter({ dir: path, format });
    if (encrypt) fs = new EncryptedAdapter(fs, encrypt.key);
    this.fs = fs;

    this._registry = new CollectionRegistry(Collection);
    this.collections = this._registry.stores;
    this._collectionInstances = this._registry._instances;
    this._migrations = new MigrationEngine();
    this._autoConnectPromise = null;
    this.isConnected = false;

    this._aiConfig = ai || null;
    this._encryptConfig = encrypt || null;
    this._pluginsConfig = Array.isArray(plugins) ? plugins : null;
    this._memoryConfig = memory || null;
    this._regexMaxLength = regexMaxLength ?? 500;
    this._idGenerator = idGenerator ?? null;
    this._serializer = serializer ?? _serialize;
    this._deserializer = deserializer ?? _deserialize;
    this._autoSave = autoSave ?? false;
    this._txManager = new TransactionManager();
    this._ttlSweepInterval = ttlSweepInterval ?? 0;
    this._ttlTimer = null;
    this._logger = logger ?? _defaultLogger;
    this._embeddingAdapter = embeddingAdapter ?? (ai ? createEmbeddingAdapter(ai) : null);
    this._aiAdapter = llmAdapter ?? (ai ? createLLMAdapter(ai) : null);
    this._persistence = new PersistenceManager({
      adapter: this.fs,
      serializer: this._serializer,
      deserializer: this._deserializer,
      logger: this._logger,
      debug: this.debug,
    });
    this._changeLog = new ChangeLog(this);
    this._queryCache = new QueryCache(queryCache || {});
    this._eventBus = new EventBus();
    this._queryLog = slowQueryLog ? new QueryLog(slowQueryLog) : null;
    this._sessionStats = new SessionStats();
    this._plugins = new PluginEngine();
    // Pre-register any plugins passed to the constructor
    if (Array.isArray(plugins)) {
      for (const p of plugins) this._plugins.register(p);
    }
  }

  // ─── Connection ──────────────────────────────────────────────────────────

  /**
   * Connect to the database: load data, run pending migrations, sweep TTL docs.
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      await this.loadData();

      // Restore persisted query cache
      const meta = this._getMeta();
      if (meta.queryCache) this._queryCache.fromJSON(meta.queryCache);

      // Run pending migrations
      if (this._migrations._migrations.length > 0) {
        const applied = meta.appliedVersions || [];
        const newApplied = await this._migrations.run(
          (version) => this.useCollection(`_migration_${version}`),
          applied
        );
        this._saveMeta({ appliedVersions: newApplied });
      }

      // Sweep expired TTL documents
      this._sweepTtl();

      // Start periodic TTL sweep if configured
      if (this._ttlSweepInterval > 0) {
        this._ttlTimer = setInterval(() => this._sweepTtl(), this._ttlSweepInterval);
      }

      this.isConnected = true;
      this._log("> - Connected to the database (√)");
    } catch (error) {
      this._logger(`Error connecting to the database: ${error}`, "error");
      throw error;
    }
  }

  /**
   * Disconnect: flush all unsaved data, clear in-memory state.
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      if (this._ttlTimer) {
        clearInterval(this._ttlTimer);
        this._ttlTimer = null;
      }
      await this.saveData();
      this._registry.clear();
      this.collections = this._registry.stores;
      this._collectionInstances = this._registry._instances;
      this._autoConnectPromise = null;
      this.isConnected = false;
      this._log("> - Disconnected from the database (√)");
    } catch (error) {
      this._logger(`Error disconnecting from the database: ${error}`, "error");
      throw error;
    }
  }

  /**
   * Ensure connect() has been called before proceeding.
   * Triggers auto-connect on the first operation if not already connected.
   * @returns {Promise<void>}
   */
  async _ensureConnected() {
    if (this.isConnected) return;
    if (!this._autoConnectPromise) {
      this._autoConnectPromise = this.connect();
    }
    return this._autoConnectPromise;
  }

  // ─── Collections ─────────────────────────────────────────────────────────

  /**
   * Get (or lazily create) a Collection instance by name.
   * @param {string} collectionName
   * @returns {Collection}
   */
  useCollection(collectionName) {
    return this._registry.get(collectionName, this);
  }

  /**
   * Define a collection with optional schema, indexes, and behaviour options.
   * Must be called before connect() so configuration is available when loading data.
   * @param {string} collectionName
   * @param {object} [options]
   * @returns {Collection}
   */
  createCollection(collectionName, options = {}) {
    return this._registry.create(collectionName, options, this);
  }

  /** @private Create a bare collection store (used internally by persistence). */
  _createCollectionStore(collectionName, options = {}) {
    this._registry.createStore(collectionName, options);
  }

  /**
   * Rename a collection. Updates in-memory state and persists the new name.
   * Requires the storage adapter to support `delete(name)`.
   * @param {string} from
   * @param {string} to
   * @returns {Promise<void>}
   */
  async renameCollection(from, to) {
    this._registry.rename(from, to);
    await this.saveData(to);
    await this.fs.delete(from);
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load all collections from the storage adapter.
   * @returns {Promise<void>}
   */
  async loadData() {
    await this._persistence.loadAll(this.collections, {
      parseSchema,
      buildIndex: this._registry.buildIndex,
      IndexEngine,
    });

    // Sync cached Collection instances with reloaded stores.
    // loadAll() replaces store objects in this.collections - any pre-existing
    // Collection instance still points to the old (empty) store.
    for (const name in this._collectionInstances) {
      const store = this.collections[name];
      if (store && this._collectionInstances[name]._store !== store) {
        this._collectionInstances[name]._store = store;
      }
    }
  }

  /**
   * Persist one or all collections via the storage adapter.
   * Implements a write queue: concurrent saves for the same collection are
   * coalesced  -  the second caller sets a flag and triggers a re-run after
   * the in-flight write completes.
   * @param {string} [collectionName] - If omitted, saves all collections.
   * @returns {Promise<void>}
   */
  async saveData(collectionName) {
    await this._persistence.save(this.collections, collectionName);
  }

  /**
   * Build a Map index from an array of documents.
   * @param {object[]} data
   * @param {string} keyField
   * @returns {Map}
   */
  buildIndex(data, keyField) {
    return this._registry.buildIndex(data, keyField);
  }

  // ─── Migrations ──────────────────────────────────────────────────────────

  /**
   * Register a migration to run on next connect().
   * @param {{ version: number, description?: string, up: Function }} migration
   */
  addMigration(migration) {
    this._migrations.add(migration);
  }

  /**
   * Report which migrations are applied vs pending.
   * @returns {{ current: number, applied: number[], pending: number[] }}
   */
  migrationStatus() {
    const meta = this._getMeta();
    return this._migrations.status(meta.appliedVersions || []);
  }

  // ─── Namespace ───────────────────────────────────────────────────────────

  /**
   * Create a scoped Skalex instance that stores data under a sub-directory.
   * @param {string} id
   * @returns {Skalex}
   */
  namespace(id) {
    if (this._adapterConfig) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_NAMESPACE_REQUIRES_FS",
        "namespace() requires the default FsAdapter. When a custom storage adapter is configured, create a separate Skalex instance with your adapter instead."
      );
    }
    // Strip path separators and traversal sequences  -  only alphanumeric, dash, and underscore allowed.
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeId) throw new ValidationError("ERR_SKALEX_VALIDATION_NAMESPACE_ID", "namespace: id must contain at least one alphanumeric character", { id });
    return new Skalex({
      path: `${this.dataDirectory}/${safeId}`,
      format: this.dataFormat,
      debug: this.debug,
      ai: this._aiConfig || undefined,
      encrypt: this._encryptConfig || undefined,
      slowQueryLog: this._queryLog ? { threshold: this._queryLog._threshold, maxEntries: this._queryLog._maxEntries } : undefined,
      queryCache: this._queryCache ? { maxSize: this._queryCache._maxSize, ttl: this._queryCache._ttl } : undefined,
      plugins: this._pluginsConfig || undefined,
      memory: this._memoryConfig || undefined,
      logger: this._logger !== _defaultLogger ? this._logger : undefined,
      llmAdapter: this._aiAdapter && !this._aiConfig ? this._aiAdapter : undefined,
      embeddingAdapter: this._embeddingAdapter && !this._aiConfig ? this._embeddingAdapter : undefined,
      regexMaxLength: this._regexMaxLength !== 500 ? this._regexMaxLength : undefined,
      idGenerator: this._idGenerator || undefined,
      serializer: this._serializer !== _serialize ? this._serializer : undefined,
      deserializer: this._deserializer !== _deserialize ? this._deserializer : undefined,
      autoSave: this._autoSave || undefined,
      ttlSweepInterval: this._ttlSweepInterval || undefined,
    });
  }

  // ─── Plugins ──────────────────────────────────────────────────────────────

  /**
   * Register a plugin. Plugins are plain objects with optional async hook
   * methods: beforeInsert, afterInsert, beforeUpdate, afterUpdate,
   * beforeDelete, afterDelete, beforeFind, afterFind, beforeSearch, afterSearch.
   *
   * @param {object} plugin
   */
  use(plugin) {
    this._plugins.register(plugin);
  }

  // ─── Global Watch ─────────────────────────────────────────────────────────

  /**
   * Subscribe to all mutation events across every collection.
   * Returns an unsubscribe function.
   *
   * @param {Function} callback - Receives { op, collection, doc, prev? } for every mutation.
   * @returns {() => void}
   */
  watch(callback) {
    return this._eventBus.on("*", callback);
  }

  // ─── Session Stats ────────────────────────────────────────────────────────

  /**
   * Return per-session read/write stats.
   * Pass a sessionId to get stats for one session, or omit to get all.
   *
   * @param {string} [sessionId]
   * @returns {{ sessionId: string, reads: number, writes: number, lastActive: Date } | Array | null}
   */
  sessionStats(sessionId) {
    if (sessionId !== undefined) return this._sessionStats.get(sessionId);
    return this._sessionStats.all();
  }

  /** Whether a transaction is currently active. */
  get _inTransaction() { return this._txManager.active; }

  // ─── Transaction helpers ─────────────────────────────────────────────────

  /**
   * Emit a collection event, or defer for after-commit if inside a transaction.
   * @param {string} collectionName
   * @param {object} data
   */
  _emitEvent(collectionName, data) {
    if (!this._txManager.defer(() => this._eventBus.emit(collectionName, data))) {
      this._eventBus.emit(collectionName, data);
    }
  }

  /**
   * Run an after-* plugin hook, or defer for after-commit if inside a transaction.
   * @param {string} hook
   * @param {object} data
   */
  async _runAfterHook(hook, data) {
    if (!this._txManager.defer(() => this._plugins.run(hook, data))) {
      await this._plugins.run(hook, data);
    }
  }

  /**
   * Append a changelog entry, or defer for after-commit if inside a transaction.
   * @param {string} op
   * @param {string} collectionName
   * @param {object} doc
   * @param {object|null} prev
   * @param {string|null} session
   */
  async _logChange(op, collectionName, doc, prev, session) {
    if (!this._txManager.defer(() => this._changeLog.log(op, collectionName, doc, prev, session))) {
      await this._changeLog.log(op, collectionName, doc, prev, session);
    }
  }

  // ─── Transaction ─────────────────────────────────────────────────────────

  /**
   * Run a callback inside a transaction.
   *
   * Lazy snapshots: only collections that receive a write are snapshotted,
   * on first mutation - not all collections upfront.
   *
   * Side effects (watch() callbacks, after-* plugin hooks, changelog entries)
   * are deferred during fn() and flushed after successful commit.
   *
   * @param {(db: Skalex) => Promise<any>} fn
   * @param {{ timeout?: number }} [opts] - timeout in ms (0 = no timeout).
   * @returns {Promise<any>} The return value of fn.
   */
  async transaction(fn, opts = {}) {
    return this._txManager.run(fn, this, opts);
  }

  // ─── Seed ────────────────────────────────────────────────────────────────

  /**
   * Seed collections with fixture data.
   * @param {object} fixtures - Map of collectionName → docs[].
   * @param {{ reset?: boolean }} [options] - If reset=true, clear before seeding.
   * @returns {Promise<void>}
   */
  async seed(fixtures, { reset = false } = {}) {
    for (const [name, docs] of Object.entries(fixtures)) {
      if (reset && this.collections[name]) {
        this._applySnapshot(name, { data: [], index: new Map() });
        delete this._collectionInstances[name];
      }
      const col = this.useCollection(name);
      await col.insertMany(docs);
    }
    await this.saveData();
  }

  // ─── Dump ────────────────────────────────────────────────────────────────

  /**
   * Return a snapshot of all collection data.
   * @returns {object} Map of collectionName → docs[].
   */
  dump() {
    return this._registry.dump();
  }

  // ─── Inspect ─────────────────────────────────────────────────────────────

  /**
   * Return metadata about one or all collections.
   * @param {string} [collectionName]
   * @returns {object|null}
   */
  inspect(collectionName) {
    return this._registry.inspect(collectionName);
  }

  // ─── Import ──────────────────────────────────────────────────────────────

  /**
   * Import documents from a JSON file into a collection.
   * The collection name is derived from the file name (without extension).
   * Requires FsAdapter (or a compatible adapter that implements `readRaw`).
   * @param {string} filePath - Absolute or relative path to the file.
   * @returns {Promise<Document[]>}
   */
  async import(filePath) {
    const content = await this.fs.readRaw(filePath);
    let docs;
    try {
      docs = JSON.parse(content);
    } catch {
      throw new PersistenceError("ERR_SKALEX_PERSISTENCE_INVALID_JSON", `import: invalid JSON in file "${filePath}"`, { filePath });
    }
    const name = filePath.split("/").pop().replace(/\.[^.]+$/, "");
    const col = this.useCollection(name);
    return col.insertMany(Array.isArray(docs) ? docs : [docs], { save: true });
  }

  // ─── Embedding ───────────────────────────────────────────────────────────

  /**
   * Embed a text string using the configured embedding adapter.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    if (!this._embeddingAdapter) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_EMBEDDING_REQUIRED",
        "db.embed() requires an AI adapter. Pass { ai: { provider, apiKey } } to the Skalex constructor."
      );
    }
    return this._embeddingAdapter.embed(text);
  }

  // ─── AI Query ─────────────────────────────────────────────────────────────

  /**
   * Natural-language query: translate `nlQuery` into a filter via the language
   * model and run it against the collection. Results are cached by query hash.
   *
   * @param {string} collectionName
   * @param {string} nlQuery
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{ docs: object[], page?: number, totalDocs?: number, totalPages?: number }>}
   */
  async ask(collectionName, nlQuery, { limit = 20 } = {}) {
    if (!this._aiAdapter) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_LLM_REQUIRED",
        'db.ask() requires a language model adapter. Configure { ai: { provider, model: "..." } }.'
      );
    }

    const col = this.useCollection(collectionName);
    const schema = this.schema(collectionName);

    // Cache lookup
    let filter = this._queryCache.get(collectionName, schema, nlQuery);
    if (!filter) {
      filter = await this._aiAdapter.generate(schema, nlQuery);
      const warnings = validateLLMFilter(filter, schema);
      if (warnings.length) warnings.forEach(w => this._log(`[ask] ${w}`));
      this._queryCache.set(collectionName, schema, nlQuery, filter);
      this._saveMeta({ queryCache: this._queryCache.toJSON() });
    }

    return col.find(processLLMFilter(filter, { regexMaxLength: this._regexMaxLength }), { limit });
  }

  // ─── Schema ──────────────────────────────────────────────────────────────

  /**
   * Return the schema for a collection as a plain `{ field: type }` object.
   * If no schema was declared, one is inferred from the first document.
   * Returns null if the collection is empty or unknown.
   *
   * @param {string} collectionName
   * @returns {object|null}
   */
  schema(collectionName) {
    return this._registry.schema(collectionName);
  }

  // ─── Agent Memory ─────────────────────────────────────────────────────────

  /**
   * Get (or create) an episodic Memory store for a session.
   * @param {string} sessionId
   * @returns {Memory}
   */
  useMemory(sessionId) {
    return new Memory(sessionId, this);
  }

  // ─── ChangeLog ────────────────────────────────────────────────────────────

  /**
   * Return the shared ChangeLog instance.
   * @returns {ChangeLog}
   */
  changelog() {
    return this._changeLog;
  }

  /**
   * Restore a collection (or a single document) to its state at `timestamp`.
   * @param {string} collectionName
   * @param {string|Date} timestamp
   * @param {{ _id?: string }} [opts]
   * @returns {Promise<void>}
   */
  async restore(collectionName, timestamp, opts = {}) {
    return this._changeLog.restore(collectionName, timestamp, opts);
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  /**
   * Return size statistics for one or all collections.
   * @param {string} [collectionName]
   * @returns {object|object[]}
   */
  stats(collectionName) {
    return this._registry.stats(collectionName);
  }

  // ─── Slow Query Log ───────────────────────────────────────────────────────

  /**
   * Return recorded slow queries (requires slowQueryLog config).
   * @param {{ limit?: number, minDuration?: number, collection?: string }} [opts]
   * @returns {object[]}
   */
  slowQueries(opts = {}) {
    if (!this._queryLog) return [];
    return this._queryLog.entries(opts);
  }

  /**
   * Number of recorded slow query entries currently in the buffer.
   * @returns {number}
   */
  slowQueryCount() {
    return this._queryLog ? this._queryLog.size : 0;
  }

  /**
   * Clear all recorded slow query entries.
   */
  clearSlowQueries() {
    this._queryLog?.clear();
  }

  // ─── MCP Server ───────────────────────────────────────────────────────────

  /**
   * Create a Skalex MCP server that exposes this database as MCP tools.
   *
   * @param {object} [opts]
   * @param {"stdio"|"http"} [opts.transport]  - Transport type. Default: "stdio".
   * @param {number}  [opts.port]              - HTTP port. Default: 3000.
   * @param {string}  [opts.host]              - HTTP host. Default: "127.0.0.1".
   * @param {object}  [opts.scopes]            - Access control map. Default: { "*": ["read"] } (read-only).
   * @returns {SkalexMCPServer}
   */
  mcp(opts = {}) {
    return new SkalexMCPServer(this, opts);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _getMeta() {
    const metaCol = this.collections["_meta"];
    if (!metaCol) return {};
    return metaCol.index.get(META_KEY) || {};
  }

  _saveMeta(data) {
    if (!this.collections["_meta"]) {
      this._createCollectionStore("_meta");
    }
    const col = this.collections["_meta"];
    const existing = col.index.get(META_KEY);
    if (existing) {
      Object.assign(existing, data);
    } else {
      const doc = { _id: META_KEY, ...data };
      col.data.push(doc);
      col.index.set(META_KEY, doc);
    }
    this._persistence.markDirty(this.collections, "_meta");
  }

  /** Sweep expired TTL documents from all collections. */
  _sweepTtl() {
    for (const name in this.collections) {
      const col = this.collections[name];
      const removed = sweep(col.data, col.index, col.fieldIndex ? doc => col.fieldIndex.remove(doc) : null);
      if (removed > 0) {
        this._persistence.markDirty(this.collections, name);
        this._log(`TTL sweep: removed ${removed} expired docs from "${name}"`);
      }
    }
  }

  /**
   * Build a lazy context that resolves properties at call time.
   * This is safe to call during the constructor before all fields are
   * initialised, because the getters defer resolution until first use.
   * @returns {CollectionContext}
   */
  _buildCollectionContext() {
    const db = this;
    return {
      ensureConnected: () => db._ensureConnected(),
      get txManager() { return db._txManager; },
      get plugins() { return db._plugins; },
      get eventBus() { return db._eventBus; },
      get sessionStats() { return db._sessionStats; },
      get queryLog() { return db._queryLog; },
      get logger() { return db._logger; },
      get persistence() { return db._persistence; },
      get collections() { return db.collections; },
      embed: (text) => db.embed(text),
      get idGenerator() { return db._idGenerator; },
      get autoSave() { return db._autoSave; },
      saveCollection: (name) => db.saveData(name),
      snapshotCollection: (col) => db._snapshotCollection(col),
      getCollection: (name) => db.useCollection(name),
      emitEvent: (name, data) => db._emitEvent(name, data),
      runAfterHook: (hook, data) => db._runAfterHook(hook, data),
      logChange: (op, col, doc, prev, session) => db._logChange(op, col, doc, prev, session),
      get fs() { return db.fs; },
      get dataDirectory() { return db.dataDirectory; },
    };
  }

  _log(msg) {
    if (this.debug) this._logger(msg, "info");
  }

  /**
   * Return a deep snapshot of a collection's mutable state.
   * Uses structuredClone to correctly preserve Date, BigInt, TypedArray,
   * Map, Set, and RegExp values  -  unlike JSON.parse/JSON.stringify.
   * Only data is snapshotted - the _id index and field indexes are rebuilt
   * from the cloned data during _applySnapshot().
   * @param {{ data: object[] }} col
   * @returns {{ data: object[] }}
   */
  _snapshotCollection(col) {
    return { data: structuredClone(col.data) };
  }

  /**
   * Apply a snapshot to a collection, rebuilding its field index if present.
   * @param {string} name
   * @param {{ data: object[], index: Map }} snap
   */
  _applySnapshot(name, snap) {
    const col = this.collections[name];
    if (!col) return;
    col.data = snap.data;
    // Rebuild the _id index from the deep-copied data so all Map values
    // point to the restored objects, not the pre-rollback mutated ones.
    col.index = this.buildIndex(snap.data, "_id");
    if (col.fieldIndex) col.fieldIndex.buildFromData(snap.data);
  }
}

export default Skalex;
