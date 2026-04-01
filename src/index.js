import Collection from "./engine/collection.js";
import { logger as _defaultLogger } from "./engine/utils.js";
import FsAdapter from "./connectors/storage/fs.js";
import MigrationEngine from "./engine/migrations.js";
import IndexEngine from "./engine/indexes.js";
import { parseSchema, inferSchema } from "./engine/validator.js";
import { sweep } from "./engine/ttl.js";
import OpenAIEmbeddingAdapter from "./connectors/embedding/openai.js";
import OllamaEmbeddingAdapter from "./connectors/embedding/ollama.js";
import OpenAILLMAdapter from "./connectors/llm/openai.js";
import AnthropicLLMAdapter from "./connectors/llm/anthropic.js";
import OllamaLLMAdapter from "./connectors/llm/ollama.js";
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
 * Skalex — an in-process document database with file-system persistence.
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

    this._adapterConfig = adapter ?? null; // track whether a custom adapter was explicitly provided
    let fs = adapter || new FsAdapter({ dir: path, format });
    if (encrypt) fs = new EncryptedAdapter(fs, encrypt.key);
    this.fs = fs;

    this.collections = {};
    this._collectionInstances = {};
    this._migrations = new MigrationEngine();
    this._autoConnectPromise = null;
    this.isConnected = false;

    this._aiConfig = ai || null;
    this._encryptConfig = encrypt || null;
    this._pluginsConfig = Array.isArray(plugins) ? plugins : null;
    this._memoryConfig = memory || null;
    this._regexMaxLength = regexMaxLength ?? 500;
    this._idGenerator = idGenerator ?? null;
    this._serializer = serializer ?? JSON.stringify;
    this._deserializer = deserializer ?? JSON.parse;
    this._autoSave = autoSave ?? false;
    this._inTransaction = false;
    this._txLock = Promise.resolve();
    this._txQueue = [];
    this._ttlSweepInterval = ttlSweepInterval ?? 0;
    this._ttlTimer = null;
    this._embeddingAdapter = embeddingAdapter ?? (ai ? this._createEmbeddingAdapter(ai) : null);
    this._aiAdapter = llmAdapter ?? (ai ? this._createAIAdapter(ai) : null);
    this._changeLog = new ChangeLog(this);
    this._queryCache = new QueryCache(queryCache || {});
    this._eventBus = new EventBus();
    this._logger = logger ?? _defaultLogger;
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
      this.collections = {};
      this._collectionInstances = {};
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
    if (this._collectionInstances[collectionName]) {
      return this._collectionInstances[collectionName];
    }
    if (!this.collections[collectionName]) {
      this._createCollectionStore(collectionName);
    }
    const instance = new Collection(this.collections[collectionName], this);
    this._collectionInstances[collectionName] = instance;
    return instance;
  }

  /**
   * Define a collection with optional schema, indexes, and behaviour options.
   * Must be called before connect() so configuration is available when loading data.
   * @param {string} collectionName
   * @param {{ schema?: object, indexes?: string[], changelog?: boolean, softDelete?: boolean, versioning?: boolean, strict?: boolean, onSchemaError?: "throw"|"warn"|"strip", defaultTtl?: number|string, defaultEmbed?: string, maxDocs?: number }} [options]
   * @returns {Collection}
   */
  createCollection(collectionName, options = {}) {
    this._createCollectionStore(collectionName, options);
    const instance = new Collection(this.collections[collectionName], this);
    this._collectionInstances[collectionName] = instance;
    return instance;
  }

  _createCollectionStore(collectionName, {
    schema,
    indexes      = [],
    changelog    = false,
    softDelete   = false,
    versioning   = false,
    strict       = false,
    onSchemaError = "throw",
    defaultTtl   = null,
    defaultEmbed = null,
    maxDocs      = null,
  } = {}) {
    let parsedSchema = null;
    let fieldIndex = null;

    if (schema) {
      parsedSchema = parseSchema(schema);
      const uniqueFields = parsedSchema.uniqueFields;
      if (indexes.length || uniqueFields.length) {
        fieldIndex = new IndexEngine(indexes, uniqueFields);
      }
    } else if (indexes.length) {
      fieldIndex = new IndexEngine(indexes, []);
    }

    this.collections[collectionName] = {
      collectionName,
      data: [],
      index: new Map(),
      isSaving: false,
      _pendingSave: false,
      schema: parsedSchema,
      rawSchema: schema || null,
      fieldIndex,
      changelog,
      softDelete,
      versioning,
      strict,
      onSchemaError,
      defaultTtl,
      defaultEmbed,
      maxDocs,
    };
  }

  /**
   * Rename a collection. Updates in-memory state and persists the new name.
   * Requires the storage adapter to support `delete(name)`.
   * @param {string} from
   * @param {string} to
   * @returns {Promise<void>}
   */
  async renameCollection(from, to) {
    if (!this.collections[from]) throw new Error(`Collection "${from}" not found`);
    if (this.collections[to])   throw new Error(`Collection "${to}" already exists`);

    const store = this.collections[from];
    store.collectionName = to;
    this.collections[to] = store;
    delete this.collections[from];

    if (this._collectionInstances[from]) {
      const inst = this._collectionInstances[from];
      inst.name = to;
      this._collectionInstances[to] = inst;
      delete this._collectionInstances[from];
    }

    await this.saveData(to);
    await this.fs.delete(from);
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load all collections from the storage adapter.
   * @returns {Promise<void>}
   */
  async loadData() {
    try {
      const names = await this.fs.list();

      await Promise.all(names.map(async (name) => {
        try {
          const raw = await this.fs.read(name);
          if (!raw) return;

          const parsed = this._deserializer(raw);
          const { collectionName, data } = parsed;
          if (!collectionName) return;

          // Prefer config from createCollection over persisted values
          const existing = this.collections[collectionName];
          const rawSchema   = existing?.rawSchema   ?? parsed.rawSchema   ?? null;
          const parsedSchema = existing?.schema     ?? (rawSchema ? parseSchema(rawSchema) : null);
          const changelog    = existing?.changelog  ?? parsed.changelog   ?? false;
          const softDelete   = existing?.softDelete ?? parsed.softDelete  ?? false;
          const versioning   = existing?.versioning ?? parsed.versioning  ?? false;
          const strict       = existing?.strict     ?? parsed.strict      ?? false;
          const onSchemaError = existing?.onSchemaError ?? parsed.onSchemaError ?? "throw";
          const defaultTtl   = existing?.defaultTtl   ?? parsed.defaultTtl   ?? null;
          const defaultEmbed = existing?.defaultEmbed ?? parsed.defaultEmbed ?? null;
          const maxDocs      = existing?.maxDocs      ?? parsed.maxDocs      ?? null;

          let fieldIndex = existing ? existing.fieldIndex : null;
          if (!fieldIndex && parsedSchema?.uniqueFields?.length) {
            fieldIndex = new IndexEngine([], parsedSchema.uniqueFields);
          }

          const idIndex = this.buildIndex(data, "_id");
          if (fieldIndex) fieldIndex.buildFromData(data);

          this.collections[collectionName] = {
            collectionName,
            data,
            index: idIndex,
            isSaving: false,
            _pendingSave: false,
            schema: parsedSchema,
            rawSchema,
            fieldIndex,
            changelog,
            softDelete,
            versioning,
            strict,
            onSchemaError,
            defaultTtl,
            defaultEmbed,
            maxDocs,
          };
        } catch (error) {
          if (error.code !== "ENOENT") {
            this._logger(`WARNING: Could not load collection "${name}": ${error.message}. Collection will be empty.`, "error");
          }
        }
      }));
    } catch (error) {
      if (error.code !== "ENOENT") {
        this._logger(`Error loading data: ${error}`, "error");
        throw error;
      }
    }
  }

  /**
   * Persist one or all collections via the storage adapter.
   * Implements a write queue: concurrent saves for the same collection are
   * coalesced — the second caller sets a flag and triggers a re-run after
   * the in-flight write completes.
   * @param {string} [collectionName] - If omitted, saves all collections.
   * @returns {Promise<void>}
   */
  async saveData(collectionName) {
    const saveOne = async (name) => {
      const col = this.collections[name];
      if (!col) return;
      if (col.isSaving) {
        col._pendingSave = true;
        return;
      }
      col.isSaving = true;
      col._pendingSave = false;
      try {
        const payload = { collectionName: name, data: col.data };
        if (col.rawSchema)                   payload.rawSchema    = col.rawSchema;
        if (col.changelog)                   payload.changelog    = col.changelog;
        if (col.softDelete)                  payload.softDelete   = col.softDelete;
        if (col.versioning)                  payload.versioning   = col.versioning;
        if (col.strict)                      payload.strict       = col.strict;
        if (col.onSchemaError !== "throw")   payload.onSchemaError = col.onSchemaError;
        if (col.defaultTtl)                  payload.defaultTtl   = col.defaultTtl;
        if (col.defaultEmbed)                payload.defaultEmbed = col.defaultEmbed;
        if (col.maxDocs)                     payload.maxDocs      = col.maxDocs;
        await this.fs.write(name, this._serializer(payload));
      } catch (error) {
        this._logger(`Error saving "${name}": ${error.message}`, "error");
        throw error;
      } finally {
        col.isSaving = false;
      }
      if (col._pendingSave) {
        col._pendingSave = false;
        await saveOne(name);
      }
    };

    if (collectionName) {
      await saveOne(collectionName);
    } else {
      await Promise.all(Object.keys(this.collections).map(saveOne));
    }
  }

  /**
   * Build a Map index from an array of documents.
   * @param {object[]} data
   * @param {string} keyField
   * @returns {Map}
   */
  buildIndex(data, keyField) {
    const index = new Map();
    for (const item of data) index.set(item[keyField], item);
    return index;
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
      throw new Error(
        "namespace() requires the default FsAdapter. " +
        "When a custom storage adapter is configured, create a separate Skalex instance with your adapter instead."
      );
    }
    // Strip path separators and traversal sequences — only alphanumeric, dash, and underscore allowed.
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeId) throw new Error("namespace: id must contain at least one alphanumeric character");
    return new Skalex({
      path: `${this.dataDirectory}/${safeId}`,
      format: this.dataFormat,
      debug: this.debug,
      ai: this._aiConfig || undefined,
      encrypt: this._encryptConfig || undefined,
      slowQueryLog: this._queryLog ? { threshold: this._queryLog._threshold, maxEntries: this._queryLog._maxEntries } : undefined,
      plugins: this._pluginsConfig || undefined,
      memory: this._memoryConfig || undefined,
      logger: this._logger !== _defaultLogger ? this._logger : undefined,
      llmAdapter: this._aiAdapter && !this._aiConfig ? this._aiAdapter : undefined,
      embeddingAdapter: this._embeddingAdapter && !this._aiConfig ? this._embeddingAdapter : undefined,
      regexMaxLength: this._regexMaxLength !== 500 ? this._regexMaxLength : undefined,
      idGenerator: this._idGenerator || undefined,
      serializer: this._serializer !== JSON.stringify ? this._serializer : undefined,
      deserializer: this._deserializer !== JSON.parse ? this._deserializer : undefined,
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

  // ─── Transaction helpers ─────────────────────────────────────────────────

  _emitEvent(collectionName, data) {
    if (this._inTransaction) {
      this._txQueue.push(() => this._eventBus.emit(collectionName, data));
      return;
    }
    this._eventBus.emit(collectionName, data);
  }

  async _runAfterHook(hook, data) {
    if (this._inTransaction) {
      this._txQueue.push(() => this._plugins.run(hook, data));
      return;
    }
    await this._plugins.run(hook, data);
  }

  async _logChange(op, collectionName, doc, prev, session) {
    if (this._inTransaction) {
      this._txQueue.push(() => this._changeLog.log(op, collectionName, doc, prev, session));
      return;
    }
    await this._changeLog.log(op, collectionName, doc, prev, session);
  }

  async _flushTxQueue() {
    const queue = this._txQueue.splice(0);
    for (const fn of queue) await fn();
  }

  // ─── Transaction ─────────────────────────────────────────────────────────

  /**
   * Run a callback inside a transaction.
   *
   * Takes an in-memory snapshot of all collections before calling fn().
   * If fn() throws, in-memory state is restored from the snapshot.
   * All writes made through the collection API during fn() are suppressed
   * from flushing to disk — a single saveData() runs only on success.
   *
   * Limitations:
   * - External side effects (HTTP calls, plugin hooks, event emissions) are not rolled back.
   * - Crash-safe atomicity across multiple collection files requires WAL (on the roadmap).
   * - Concurrent transactions are serialised via an internal lock.
   *
   * @param {(db: Skalex) => Promise<any>} fn
   * @returns {Promise<any>} The return value of fn.
   */
  async transaction(fn) {
    const run = async () => {
      const snapshot = {};
      for (const name in this.collections) {
        snapshot[name] = this._snapshotCollection(this.collections[name]);
      }

      this._inTransaction = true;
      try {
        const result = await fn(this);
        this._inTransaction = false;
        await this._flushTxQueue();
        await this.saveData();
        return result;
      } catch (error) {
        this._inTransaction = false;
        this._txQueue = [];
        // Rollback: restore snapshotted collections
        for (const name in snapshot) this._applySnapshot(name, snapshot[name]);
        // Remove collections created during the failed transaction
        for (const name in this.collections) {
          if (!(name in snapshot)) {
            delete this.collections[name];
            delete this._collectionInstances[name];
          }
        }
        throw error;
      }
    };

    // Serialise concurrent transactions via a promise-chain lock
    const next = this._txLock.then(run);
    this._txLock = next.catch(() => {});
    return next;
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
    const result = {};
    for (const name in this.collections) {
      if (!name.startsWith("_")) result[name] = [...this.collections[name].data];
    }
    return result;
  }

  // ─── Inspect ─────────────────────────────────────────────────────────────

  /**
   * Return metadata about one or all collections.
   * @param {string} [collectionName]
   * @returns {object|null}
   */
  inspect(collectionName) {
    if (collectionName) {
      const col = this.collections[collectionName];
      if (!col) return null;
      return {
        name:         collectionName,
        count:        col.data.length,
        schema:       col.schema ? Object.fromEntries(col.schema.fields) : null,
        indexes:      col.fieldIndex ? [...col.fieldIndex.indexedFields] : [],
        softDelete:   col.softDelete   ?? false,
        versioning:   col.versioning   ?? false,
        strict:       col.strict       ?? false,
        onSchemaError: col.onSchemaError ?? "throw",
        maxDocs:      col.maxDocs      ?? null,
      };
    }
    const result = {};
    for (const name in this.collections) {
      result[name] = this.inspect(name);
    }
    return result;
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
      throw new Error(`import: invalid JSON in file "${filePath}"`);
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
      throw new Error(
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
      throw new Error(
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
    const store = this.collections[collectionName];
    if (!store) return null;
    if (store.schema) {
      return Object.fromEntries(
        [...store.schema.fields.entries()].map(([k, v]) => [k, v.type])
      );
    }
    if (store.data.length > 0) return inferSchema(store.data[0]);
    return null;
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
    const calc = (name) => {
      const col = this.collections[name];
      if (!col) return null;
      const count = col.data.length;
      let estimatedSize = 0;
      for (const doc of col.data) {
        try { estimatedSize += JSON.stringify(doc).length; } catch (_) {}
      }
      return {
        collection:    name,
        count,
        estimatedSize,
        avgDocSize:    count > 0 ? Math.round(estimatedSize / count) : 0,
      };
    };

    if (collectionName) return calc(collectionName);
    return Object.keys(this.collections).map(calc);
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
  }

  /** Sweep expired TTL documents from all collections. */
  _sweepTtl() {
    for (const name in this.collections) {
      const col = this.collections[name];
      const removed = sweep(col.data, col.index, col.fieldIndex ? doc => col.fieldIndex.remove(doc) : null);
      if (removed > 0) this._log(`TTL sweep: removed ${removed} expired docs from "${name}"`);
    }
  }

  _createEmbeddingAdapter({ provider, apiKey, embedModel, model, host, embedBaseUrl, dimensions, organization, embedTimeout, embedRetries, embedRetryDelay }) {
    const resolvedModel = embedModel || model;
    switch (provider) {
      case "openai":
        return new OpenAIEmbeddingAdapter({
          apiKey,
          model: resolvedModel,
          baseUrl: embedBaseUrl,
          ...(dimensions      !== undefined && { dimensions }),
          ...(organization    !== undefined && { organization }),
          ...(embedTimeout    !== undefined && { timeout:    embedTimeout }),
          ...(embedRetries    !== undefined && { retries:    embedRetries }),
          ...(embedRetryDelay !== undefined && { retryDelay: embedRetryDelay }),
        });
      case "ollama":
        return new OllamaEmbeddingAdapter({
          model: resolvedModel,
          host,
          ...(embedTimeout    !== undefined && { timeout:    embedTimeout }),
          ...(embedRetries    !== undefined && { retries:    embedRetries }),
          ...(embedRetryDelay !== undefined && { retryDelay: embedRetryDelay }),
        });
      default:
        throw new Error(
          `Unknown AI provider: "${provider}". Supported: "openai", "ollama".`
        );
    }
  }

  _createAIAdapter({ provider, apiKey, model, host, baseUrl, apiVersion, temperature, maxTokens, topP, topK, organization, timeout, retries, retryDelay, seed, generatePrompt, summarizePrompt }) {
    if (!model) return null; // LLM adapter is optional
    switch (provider) {
      case "openai":
        return new OpenAILLMAdapter({
          apiKey,
          model,
          baseUrl,
          ...(maxTokens    !== undefined && { maxTokens }),
          ...(temperature  !== undefined && { temperature }),
          ...(topP         !== undefined && { topP }),
          ...(organization !== undefined && { organization }),
          ...(timeout      !== undefined && { timeout }),
          ...(retries         !== undefined && { retries }),
          ...(retryDelay      !== undefined && { retryDelay }),
          ...(seed            !== undefined && { seed }),
          ...(generatePrompt  !== undefined && { generatePrompt }),
          ...(summarizePrompt !== undefined && { summarizePrompt }),
        });
      case "anthropic":
        return new AnthropicLLMAdapter({
          apiKey,
          model,
          baseUrl,
          apiVersion,
          ...(maxTokens       !== undefined && { maxTokens }),
          ...(temperature     !== undefined && { temperature }),
          ...(topP            !== undefined && { topP }),
          ...(topK            !== undefined && { topK }),
          ...(timeout         !== undefined && { timeout }),
          ...(retries         !== undefined && { retries }),
          ...(retryDelay      !== undefined && { retryDelay }),
          ...(generatePrompt  !== undefined && { generatePrompt }),
          ...(summarizePrompt !== undefined && { summarizePrompt }),
        });
      case "ollama":
        return new OllamaLLMAdapter({
          model,
          host,
          ...(temperature     !== undefined && { temperature }),
          ...(topP            !== undefined && { topP }),
          ...(topK            !== undefined && { topK }),
          ...(timeout         !== undefined && { timeout }),
          ...(retries         !== undefined && { retries }),
          ...(retryDelay      !== undefined && { retryDelay }),
          ...(generatePrompt  !== undefined && { generatePrompt }),
          ...(summarizePrompt !== undefined && { summarizePrompt }),
        });
      default:
        return null; // unknown provider — skip silently (embedding may still work)
    }
  }

  _log(msg) {
    if (this.debug) this._logger(msg, "info");
  }

  /**
   * Return a deep snapshot of a collection's mutable state.
   * Uses structuredClone to correctly preserve Date, BigInt, TypedArray,
   * Map, Set, and RegExp values — unlike JSON.parse/JSON.stringify.
   * @param {{ data: object[], index: Map }} col
   * @returns {{ data: object[], index: Map }}
   */
  _snapshotCollection(col) {
    return {
      data: structuredClone(col.data),
      index: new Map(col.index),
    };
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
