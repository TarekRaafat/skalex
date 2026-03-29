const Collection = require("./collection");
const { logger } = require("./utils");
const FsAdapter = require("./adapters/storage/fs");
const MigrationEngine = require("./migrations");
const IndexEngine = require("./indexes");
const { parseSchema } = require("./validator");
const { sweep } = require("./ttl");

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
   */
  constructor({ path = "./.db", format = "gz", debug = false, adapter } = {}) {
    this.dataDirectory = path;
    this.dataFormat = format;
    this.debug = debug;

    this.fs = adapter || new FsAdapter({ dir: path, format });

    this.collections = {};
    this._collectionInstances = {};
    this._migrations = new MigrationEngine();
    this._autoConnectPromise = null;
    this.isConnected = false;
  }

  // ─── Connection ──────────────────────────────────────────────────────────

  /**
   * Connect to the database: load data, run pending migrations, sweep TTL docs.
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      await this.loadData();

      // Run pending migrations
      if (this._migrations._migrations.length > 0) {
        const meta = this._getMeta();
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

  _createCollectionStore(collectionName, { schema, indexes = [] } = {}) {
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

  _log(msg) {
    if (this.debug) logger(msg);
  }
}

module.exports = Skalex;
