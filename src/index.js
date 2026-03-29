const Collection = require("./collection");
const { logger } = require("./utils");
const FsAdapter = require("./adapters/storage/fs");
const MigrationEngine = require("./migrations");
const IndexEngine = require("./indexes");
const { parseSchema, inferSchema } = require("./validator");
const { sweep } = require("./ttl");
const OpenAIEmbeddingAdapter = require("./adapters/embedding/openai");
const OllamaEmbeddingAdapter = require("./adapters/embedding/ollama");
const OpenAIAIAdapter = require("./adapters/ai/openai");
const AnthropicAIAdapter = require("./adapters/ai/anthropic");
const OllamaAIAdapter = require("./adapters/ai/ollama");
const EncryptedAdapter = require("./adapters/storage/encrypted");
const Memory = require("./memory");
const ChangeLog = require("./changelog");
const { QueryCache, processLLMFilter, validateLLMFilter } = require("./ask");
const EventBus = require("./events");
const QueryLog = require("./query-log");
const SkalexMCPServer = require("./mcp/index");

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
   * @param {object}  [config.slowQueryLog]        - Slow query log options.
   * @param {number}  [config.slowQueryLog.threshold] - Duration threshold in ms. Default: 100.
   * @param {number}  [config.slowQueryLog.maxEntries] - Max entries to keep. Default: 500.
   */
  constructor({ path = "./.db", format = "gz", debug = false, adapter, ai, encrypt, slowQueryLog } = {}) {
    this.dataDirectory = path;
    this.dataFormat = format;
    this.debug = debug;

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
    this._embeddingAdapter = ai ? this._createEmbeddingAdapter(ai) : null;
    this._aiAdapter = ai ? this._createAIAdapter(ai) : null;
    this._changeLog = new ChangeLog(this);
    this._queryCache = new QueryCache();
    this._eventBus = new EventBus();
    this._queryLog = slowQueryLog ? new QueryLog(slowQueryLog) : null;
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
      for (const name in this.collections) {
        const col = this.collections[name];
        const removed = sweep(col.data, col.index, col.fieldIndex ? doc => col.fieldIndex.remove(doc) : null);
        if (removed > 0) this._log(`TTL sweep: removed ${removed} expired docs from "${name}"`);
      }

      this.isConnected = true;
      this._log("> - Connected to the database (√)");
    } catch (error) {
      logger(`Error connecting to the database: ${error}`, "error");
      throw error;
    }
  }

  /**
   * Disconnect: flush all unsaved data, clear in-memory state.
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      await this.saveData();
      this.collections = {};
      this._collectionInstances = {};
      this._autoConnectPromise = null;
      this.isConnected = false;
      this._log("> - Disconnected from the database (√)");
    } catch (error) {
      logger(`Error disconnecting from the database: ${error}`, "error");
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
   * Define a collection with optional schema and secondary indexes.
   * Must be called before connect() so schema is available when loading data.
   * @param {string} collectionName
   * @param {{ schema?: object, indexes?: string[] }} [options]
   * @returns {Collection}
   */
  createCollection(collectionName, options = {}) {
    this._createCollectionStore(collectionName, options);
    const instance = new Collection(this.collections[collectionName], this);
    this._collectionInstances[collectionName] = instance;
    return instance;
  }

  _createCollectionStore(collectionName, { schema, indexes = [], changelog = false } = {}) {
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
      schema: parsedSchema,
      fieldIndex,
      changelog,
    };
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

          const parsed = JSON.parse(raw);
          const { collectionName, data } = parsed;
          if (!collectionName) return;

          // Preserve schema/index config from createCollection, if any
          const existing = this.collections[collectionName];
          const parsedSchema = existing ? existing.schema : null;
          let fieldIndex = existing ? existing.fieldIndex : null;

          const idIndex = this.buildIndex(data, "_id");
          if (fieldIndex) fieldIndex.buildFromData(data);

          this.collections[collectionName] = {
            collectionName,
            data,
            index: idIndex,
            isSaving: false,
            schema: parsedSchema,
            fieldIndex,
          };
        } catch (error) {
          if (error.code !== "ENOENT") {
            logger(`WARNING: Could not load collection "${name}": ${error.message}. Collection will be empty.`, "error");
          }
        }
      }));
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger(`Error loading data: ${error}`, "error");
        throw error;
      }
    }
  }

  /**
   * Persist one or all collections via the storage adapter.
   * @param {string} [collectionName] - If omitted, saves all collections.
   * @returns {Promise<void>}
   */
  async saveData(collectionName) {
    const saveOne = async (name) => {
      const col = this.collections[name];
      if (!col || col.isSaving) return;
      col.isSaving = true;
      try {
        await this.fs.write(name, JSON.stringify({ collectionName: name, data: col.data }));
      } catch (error) {
        logger(`Error saving "${name}": ${error.message}`, "error");
        throw error;
      } finally {
        col.isSaving = false;
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
    return new Skalex({
      path: `${this.dataDirectory}/${id}`,
      format: this.dataFormat,
      debug: this.debug,
      ai: this._aiConfig || undefined,
      encrypt: this._encryptConfig || undefined,
      slowQueryLog: this._queryLog ? { threshold: this._queryLog._threshold, maxEntries: this._queryLog._maxEntries } : undefined,
    });
  }

  // ─── Transaction ─────────────────────────────────────────────────────────

  /**
   * Run a callback inside a transaction.
   * All writes are buffered; if the callback throws, all changes are rolled back.
   * @param {(db: Skalex) => Promise<any>} fn
   * @returns {Promise<any>} The return value of fn.
   */
  async transaction(fn) {
    // Deep-copy snapshot before transaction
    const snapshot = {};
    for (const name in this.collections) {
      snapshot[name] = {
        data: JSON.parse(JSON.stringify(this.collections[name].data)),
        index: new Map(this.collections[name].index),
      };
    }

    try {
      const result = await fn(this);
      await this.saveData();
      return result;
    } catch (error) {
      // Rollback
      for (const name in snapshot) {
        if (!this.collections[name]) continue;
        this.collections[name].data = snapshot[name].data;
        this.collections[name].index = snapshot[name].index;
        if (this.collections[name].fieldIndex) {
          this.collections[name].fieldIndex.buildFromData(snapshot[name].data);
        }
      }
      throw error;
    }
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
      const col = this.useCollection(name);
      if (reset) {
        this.collections[name].data = [];
        this.collections[name].index = new Map();
        if (this.collections[name].fieldIndex) {
          this.collections[name].fieldIndex.buildFromData([]);
        }
        // Evict cached instance so it sees the reset store
        delete this._collectionInstances[name];
      }
      await this.useCollection(name).insertMany(docs);
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
      result[name] = [...this.collections[name].data];
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
        name: collectionName,
        count: col.data.length,
        schema: col.schema ? Object.fromEntries(col.schema.fields) : null,
        indexes: col.fieldIndex ? [...col.fieldIndex.indexedFields] : [],
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
   * Import documents from a JSON or CSV file into a collection.
   * The collection name is derived from the file name (without extension).
   * @param {string} filePath - Absolute or relative path to the file.
   * @param {"json"|"csv"} [format="json"]
   * @returns {Promise<{ docs: object[] }>}
   */
  async import(filePath, format = "json") {
    const content = await this.fs.readRaw(filePath);
    let docs;

    if (format === "json") {
      docs = JSON.parse(content);
    } else {
      const lines = content.trim().split("\n");
      const headers = lines[0].split(",");
      docs = lines.slice(1).map(line => {
        const values = line.split(",");
        const doc = {};
        headers.forEach((h, i) => { doc[h.trim()] = values[i] ? values[i].trim() : ""; });
        return doc;
      });
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
    const store = this.collections[collectionName];

    // Build a schema descriptor for the LLM
    let schema = null;
    if (store && store.schema) {
      schema = Object.fromEntries(
        [...store.schema.fields.entries()].map(([k, v]) => [k, v.type])
      );
    } else if (store && store.data.length > 0) {
      schema = inferSchema(store.data[0]);
    }

    // Cache lookup
    let filter = this._queryCache.get(collectionName, schema, nlQuery);
    if (!filter) {
      filter = await this._aiAdapter.generate(schema, nlQuery);
      const warnings = validateLLMFilter(filter, schema);
      if (warnings.length) warnings.forEach(w => this._log(`[ask] ${w}`));
      this._queryCache.set(collectionName, schema, nlQuery, filter);
      this._saveMeta({ queryCache: this._queryCache.toJSON() });
    }

    return col.find(processLLMFilter(filter), { limit });
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

  // ─── MCP Server ───────────────────────────────────────────────────────────

  /**
   * Create a Skalex MCP server that exposes this database as MCP tools.
   *
   * @param {object} [opts]
   * @param {"stdio"|"http"} [opts.transport]  - Transport type. Default: "stdio".
   * @param {number}  [opts.port]              - HTTP port. Default: 3000.
   * @param {string}  [opts.host]              - HTTP host. Default: "127.0.0.1".
   * @param {object}  [opts.scopes]            - Access control map. Default: { "*": ["read", "write"] }.
   * @returns {SkalexMCPServer}
   */
  mcp(opts = {}) {
    return new SkalexMCPServer(this, opts);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _getMeta() {
    const metaCol = this.collections["_meta"];
    if (!metaCol) return {};
    return metaCol.index.get("migrations") || {};
  }

  _saveMeta(data) {
    if (!this.collections["_meta"]) {
      this._createCollectionStore("_meta");
    }
    const col = this.collections["_meta"];
    const existing = col.index.get("migrations");
    if (existing) {
      Object.assign(existing, data);
    } else {
      const doc = { _id: "migrations", ...data };
      col.data.push(doc);
      col.index.set("migrations", doc);
    }
  }

  _createEmbeddingAdapter({ provider, apiKey, embedModel, model, host }) {
    const resolvedModel = embedModel || model;
    switch (provider) {
      case "openai":
        return new OpenAIEmbeddingAdapter({ apiKey, model: resolvedModel });
      case "ollama":
        return new OllamaEmbeddingAdapter({ model: resolvedModel, host });
      default:
        throw new Error(
          `Unknown AI provider: "${provider}". Supported: "openai", "ollama".`
        );
    }
  }

  _createAIAdapter({ provider, apiKey, model, host }) {
    if (!model) return null; // LLM adapter is optional
    switch (provider) {
      case "openai":
        return new OpenAIAIAdapter({ apiKey, model });
      case "anthropic":
        return new AnthropicAIAdapter({ apiKey, model });
      case "ollama":
        return new OllamaAIAdapter({ model, host });
      default:
        return null; // unknown provider — skip silently (embedding may still work)
    }
  }

  _log(msg) {
    if (this.debug) logger(msg);
  }
}

module.exports = Skalex;
