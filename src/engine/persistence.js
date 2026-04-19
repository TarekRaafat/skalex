/**
 * persistence.js  -  PersistenceManager for Skalex.
 *
 * Owns all load/save orchestration, dirty tracking, write-queue coalescing,
 * flush sentinel management, and orphan temp-file cleanup.
 */
import { PersistenceError } from "./errors.js";

/** Key used to store persistence metadata in the _meta collection. */
const FLUSH_META_KEY = "_flush";
/** _id of the meta document inside the _meta collection. */
const META_DOC_ID = "migrations";

class PersistenceManager {
  /**
   * @param {object} opts
   * @param {import("../connectors/storage/base.js").default} opts.adapter - Storage adapter.
   * @param {Function} opts.serializer   - (value) => string
   * @param {Function} opts.deserializer - (text) => value
   * @param {Function} opts.logger       - (msg, level) => void
   * @param {boolean}  [opts.debug=false]
   */
  get [Symbol.toStringTag]() { return "PersistenceManager"; }

  constructor({ adapter, serializer, deserializer, logger, debug = false, lenientLoad = false, registry = null }) {
    this._adapter = adapter;
    this._serializer = serializer;
    this._deserializer = deserializer;
    this._logger = logger;
    this._debug = debug;
    this._lenientLoad = lenientLoad;
    /** @type {import("./registry.js").default|null} Back-reference used for canonical store construction. */
    this._registry = registry;

    /**
     * Promise-chain lock to serialize concurrent saveAtomic() calls.
     * Regular saves (save/saveDirty) do not acquire this lock - they
     * rely on per-collection coalescing in _saveOne() instead.
     */
    this._saveLock = Promise.resolve();
  }

  /**
   * Acquire the save lock, execute fn, then release.
   * @param {Function} fn - async () => void
   * @returns {Promise<void>}
   */
  _withSaveLock(fn) {
    const next = this._saveLock.then(fn);
    this._saveLock = next.catch(() => {});
    return next;
  }

  // ─── Load ──────────────────────────────────────────────────────────────

  /**
   * Load all collections from the storage adapter.
   * Detects incomplete flushes and cleans orphan temp files.
   *
   * @param {object} collections         - Live collections map (mutated in place).
   * @param {Function} parseSchema       - Schema parser.
   * @param {Function} buildIndex        - (data, keyField) => Map
   * @param {Function} IndexEngine       - IndexEngine class.
   * @returns {Promise<void>}
   */
  /** Attach the registry used for canonical store construction. */
  setRegistry(registry) {
    this._registry = registry;
  }

  async loadAll(collections, { parseSchema, buildIndex, IndexEngine }) {
    try {
      const names = await this._adapter.list();

      await Promise.all(names.map(async (name) => {
        try {
          const raw = await this._adapter.read(name);
          if (!raw) return;

          const parsed = this._deserializer(raw);
          const { collectionName, data } = parsed;
          if (!collectionName) return;

          // Prefer config from createCollection over persisted values
          const existing = collections[collectionName];
          const rawSchema = existing?.rawSchema ?? parsed.rawSchema ?? null;
          const parsedSchema = existing?.schema ?? (rawSchema ? parseSchema(rawSchema) : null);
          const changelog = existing?.changelog ?? parsed.changelog ?? false;
          const softDelete = existing?.softDelete ?? parsed.softDelete ?? false;
          const versioning = existing?.versioning ?? parsed.versioning ?? false;
          const strict = existing?.strict ?? parsed.strict ?? false;
          const onSchemaError = existing?.onSchemaError ?? parsed.onSchemaError ?? "throw";
          const defaultTtl = existing?.defaultTtl ?? parsed.defaultTtl ?? null;
          const defaultEmbed = existing?.defaultEmbed ?? parsed.defaultEmbed ?? null;
          const maxDocs = existing?.maxDocs ?? parsed.maxDocs ?? null;

          let fieldIndex = existing ? existing.fieldIndex : null;
          if (!fieldIndex && parsedSchema?.uniqueFields?.length) {
            fieldIndex = new IndexEngine([], parsedSchema.uniqueFields);
          }

          const idIndex = buildIndex(data, "_id");
          if (fieldIndex) fieldIndex.buildFromData(data);

          // Build the canonical store shape via the registry (single construction
          // path), then merge loaded data/options into it. If a new store field
          // is added to registry.createStore(), it automatically applies here too.
          if (this._registry) {
            this._registry.createStore(collectionName, {
              schema: rawSchema,
              changelog,
              softDelete,
              versioning,
              strict,
              onSchemaError,
              defaultTtl,
              defaultEmbed,
              maxDocs,
            });
            const store = this._registry.stores[collectionName];
            store.data = data;
            store.index = idIndex;
            // Preserve the index instance already built from loaded data.
            if (fieldIndex) store.fieldIndex = fieldIndex;
            collections[collectionName] = store;
          } else {
            collections[collectionName] = {
              collectionName,
              data,
              index: idIndex,
              isSaving: false,
              _pendingSave: false,
              _dirty: false,
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
          }
        } catch (error) {
          if (error.code === "ENOENT") return;
          if (this._lenientLoad) {
            this._logger(`WARNING: Could not load collection "${name}": ${error.message}. Collection will be empty.`, "error");
            return;
          }
          throw new PersistenceError(
            "ERR_SKALEX_PERSISTENCE_CORRUPT",
            `Failed to load collection "${name}": ${error.message}`,
            { collection: name }
          );
        }
      }));

      // Detect incomplete flush and clean orphan temp files
      this._detectIncompleteFlush(collections);
      await this._cleanOrphanTempFiles();
    } catch (error) {
      if (error.code !== "ENOENT") {
        this._logger(`Error loading data: ${error}`, "error");
        throw error;
      }
    }
  }

  // ─── Save ──────────────────────────────────────────────────────────────

  /**
   * Persist one or all collections via the storage adapter.
   *
   * Best-effort semantics: each collection is written independently via
   * Promise.all. If one collection write fails, others may have already
   * committed. For atomic multi-collection writes, use saveAtomic()
   * (called automatically by transaction commit).
   *
   * Write queue: concurrent saves for the same collection are coalesced -
   * the second caller waits until the in-flight write completes and a
   * re-save runs with the latest data.
   *
   * @param {object} collections - Live collections map.
   * @param {string} [collectionName] - If omitted, saves all collections.
   * @returns {Promise<void>}
   */
  async save(collections, collectionName) {
    if (collectionName) {
      await this._saveOne(collections, collectionName);
    } else {
      await Promise.all(Object.keys(collections).map(name => this._saveOne(collections, name)));
    }
  }

  /**
   * Persist only collections marked dirty. Resets dirty flag after save.
   * Same best-effort semantics as save() - each dirty collection is
   * written independently.
   * @param {object} collections - Live collections map.
   * @returns {Promise<void>}
   */
  async saveDirty(collections) {
    const dirtyNames = Object.keys(collections).filter(name => collections[name]._dirty);
    if (dirtyNames.length === 0) return;
    await Promise.all(dirtyNames.map(name => this._saveOne(collections, name)));
  }

  /**
   * Batch save of specific collections via writeAll().
   * Used by transactions to commit all touched collections together.
   *
   * Strategy: include _meta (with flush sentinel) in the single writeAll()
   * batch so all data and metadata go through one adapter-level operation.
   * SQL adapters (BunSQLite, D1, LibSQL) get native atomicity; FsAdapter
   * gets a narrowed failure window (sequential renames). If the batch
   * fails, the sentinel survives on disk for crash detection on next load.
   *
   * After a successful batch, the sentinel is cleared and _meta is written
   * once more. If that final write fails, the sentinel remains - which is
   * the correct "incomplete" signal.
   *
   * @param {object} collections - Live collections map.
   * @param {string[]} names - Collection names to save.
   * @returns {Promise<void>}
   */
  saveAtomic(collections, names) {
    return this._withSaveLock(async () => {
      if (names.length === 0) return;

      // Set flush sentinel in memory before serializing
      this._writeFlushSentinel(collections, names);

      // Build a single batch including _meta alongside the touched collections
      const allNames = new Set(names);
      allNames.add("_meta");

      const entries = [...allNames]
        .filter(n => collections[n])
        .map(name => ({ name, data: this._serializeCollection(collections[name]) }));

      try {
        await this._adapter.writeAll(entries);
      } catch (error) {
        throw new PersistenceError(
          "ERR_SKALEX_PERSISTENCE_FLUSH_FAILED",
          `Batch save failed during writeAll: ${error.message}`,
          { collections: names }
        );
      }

      // Batch succeeded - clear dirty flags
      for (const name of names) {
        if (collections[name]) collections[name]._dirty = false;
      }

      // Clear sentinel and persist _meta one final time.
      // If this fails, the sentinel remains on disk - correct "incomplete" signal.
      try {
        this._clearFlushSentinel(collections);
        await this._adapter.write("_meta", this._serializeCollection(collections["_meta"]));
      } catch (error) {
        this._logger(
          `WARNING: Batch data committed but sentinel clear failed: ${error.message}. ` +
          `Next load will report an incomplete flush (false positive).`,
          "error"
        );
      }
    });
  }

  /**
   * Mark a collection as dirty (needs persistence).
   * @param {object} collections
   * @param {string} name
   */
  markDirty(collections, name) {
    const col = collections[name];
    if (col) {
      col._dirty = true;
      col._statsDirty = true;
    }
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  /**
   * Serialize a collection store into a persistable string.
   * @param {object} col
   * @returns {string}
   */
  _serializeCollection(col) {
    const payload = { collectionName: col.collectionName, data: col.data };
    if (col.rawSchema) payload.rawSchema = col.rawSchema;
    if (col.changelog) payload.changelog = col.changelog;
    if (col.softDelete) payload.softDelete = col.softDelete;
    if (col.versioning) payload.versioning = col.versioning;
    if (col.strict) payload.strict = col.strict;
    if (col.onSchemaError !== "throw") payload.onSchemaError = col.onSchemaError;
    if (col.defaultTtl) payload.defaultTtl = col.defaultTtl;
    if (col.defaultEmbed) payload.defaultEmbed = col.defaultEmbed;
    if (col.maxDocs) payload.maxDocs = col.maxDocs;
    return this._serializer(payload);
  }

  // ─── Private ───────────────────────────────────────────────────────────

  /**
   * Persist a single collection. Implements per-collection write coalescing:
   * if a write is in-flight, the caller is queued and resolved only after
   * the coalesced re-save completes with the latest data.
   *
   * @param {object} collections
   * @param {string} name
   * @returns {Promise<void>}
   */
  async _saveOne(collections, name) {
    const col = collections[name];
    if (!col) return;

    // Write coalescing: queue this caller behind the in-flight write.
    if (col.isSaving) {
      col._pendingSave = true;
      return new Promise((resolve, reject) => {
        (col._saveWaiters ??= []).push({ resolve, reject });
      });
    }

    col.isSaving = true;
    col._pendingSave = false;

    try {
      await this._writeCollection(name, col);
      // Re-save loop: drain any callers that arrived during the write.
      while (col._pendingSave) {
        col._pendingSave = false;
        await this._writeCollection(name, col);
      }
      this._resolveSaveWaiters(col);
    } catch (error) {
      this._rejectSaveWaiters(col, error);
      throw error;
    } finally {
      col.isSaving = false;
    }
  }

  /**
   * Execute the actual adapter write for a collection.
   * @param {string} name
   * @param {object} col
   * @returns {Promise<void>}
   */
  async _writeCollection(name, col) {
    try {
      await this._adapter.write(name, this._serializeCollection(col));
      col._dirty = false;
    } catch (error) {
      this._logger(`Error saving "${name}": ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * Resolve all queued save waiters for a collection.
   * @param {object} col
   */
  _resolveSaveWaiters(col) {
    const waiters = col._saveWaiters?.splice(0) ?? [];
    for (const w of waiters) w.resolve();
  }

  /**
   * Reject all queued save waiters for a collection.
   * @param {object} col
   * @param {Error} error
   */
  _rejectSaveWaiters(col, error) {
    const waiters = col._saveWaiters?.splice(0) ?? [];
    for (const w of waiters) w.reject(error);
  }

  /**
   * Write a flush sentinel into the _meta collection before a batch save.
   * If the process crashes mid-flush, the sentinel survives and is
   * detected on the next loadAll().
   */
  _writeFlushSentinel(collections, names) {
    const meta = this._getOrCreateMeta(collections);
    meta[FLUSH_META_KEY] = {
      startedAt: new Date().toISOString(),
      collections: names,
      completedAt: null,
    };
  }

  /**
   * Clear the flush sentinel after a successful batch save.
   */
  _clearFlushSentinel(collections) {
    const meta = this._getOrCreateMeta(collections);
    if (meta[FLUSH_META_KEY]) {
      meta[FLUSH_META_KEY].completedAt = new Date().toISOString();
    }
  }

  /**
   * On load, check if a flush sentinel indicates an incomplete previous write.
   */
  _detectIncompleteFlush(collections) {
    const metaCol = collections["_meta"];
    if (!metaCol) return;
    const metaDoc = metaCol.index.get(META_DOC_ID);
    if (!metaDoc) return;
    const flush = metaDoc[FLUSH_META_KEY];
    if (!flush) return;
    if (flush.startedAt && !flush.completedAt) {
      this._logger(
        `WARNING: Incomplete flush detected (started ${flush.startedAt}, collections: ${flush.collections?.join(", ")}). Data may be inconsistent.`,
        "error"
      );
    }
  }

  /**
   * Delegate orphan temp-file cleanup to the adapter, if supported.
   * Non-FS adapters (browser LocalStorage, D1, SQLite, etc.) don't implement
   * `cleanOrphans` and this is a no-op for them.
   */
  async _cleanOrphanTempFiles() {
    if (typeof this._adapter.cleanOrphans !== "function") return;
    try {
      const removed = await this._adapter.cleanOrphans();
      if (removed > 0) this._logger(`Cleaned ${removed} orphan temp file(s) (indicates prior incomplete write)`, "warn");
    } catch { /* ignore cleanup failures */ }
  }

  /**
   * Return the canonical `_meta` document, creating the collection and the
   * document if they do not exist. The collection shape is built via the
   * registry's single `createStore()` path so it can never drift.
   * @param {object} collections - Live collections map (mutated in place).
   * @returns {object} The meta document.
   */
  _getOrCreateMeta(collections) {
    if (!collections["_meta"]) {
      if (!this._registry) {
        throw new PersistenceError(
          "ERR_SKALEX_PERSISTENCE_NO_REGISTRY",
          "PersistenceManager requires a registry to construct _meta."
        );
      }
      this._registry.createStore("_meta");
      collections["_meta"] = this._registry.stores["_meta"];
    }
    const metaCol = collections["_meta"];
    let doc = metaCol.index.get(META_DOC_ID);
    if (!doc) {
      doc = { _id: META_DOC_ID };
      metaCol.data.push(doc);
      metaCol.index.set(META_DOC_ID, doc);
    }
    return doc;
  }

  /**
   * Return the current `_meta` document content (sans `_id`), or an empty
   * object if none exists. The collection is not mutated if absent.
   * @param {object} collections - Live collections map.
   * @returns {object}
   */
  getMeta(collections) {
    const metaCol = collections["_meta"];
    if (!metaCol) return {};
    return metaCol.index.get(META_DOC_ID) || {};
  }

  /**
   * Merge the given data into the `_meta` document and mark it dirty.
   * Creates the `_meta` collection and document if needed.
   * @param {object} collections - Live collections map (mutated in place).
   * @param {object} data - Fields to merge.
   */
  updateMeta(collections, data) {
    const doc = this._getOrCreateMeta(collections);
    Object.assign(doc, data);
    this.markDirty(collections, "_meta");
  }

  _log(msg) {
    if (this._debug) this._logger(msg, "info");
  }
}

export default PersistenceManager;
