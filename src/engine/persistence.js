/**
 * persistence.js  -  PersistenceManager for Skalex.
 *
 * Owns all load/save orchestration, dirty tracking, write-queue coalescing,
 * flush sentinel management, and orphan temp-file cleanup.
 */
import { PersistenceError } from "./errors.js";

/** Key used to store persistence metadata in the _meta collection. */
const FLUSH_META_KEY = "_flush";

class PersistenceManager {
  /**
   * @param {object} opts
   * @param {import("../connectors/storage/base.js").default} opts.adapter - Storage adapter.
   * @param {Function} opts.serializer   - (value) => string
   * @param {Function} opts.deserializer - (text) => value
   * @param {Function} opts.logger       - (msg, level) => void
   * @param {boolean}  [opts.debug=false]
   */
  constructor({ adapter, serializer, deserializer, logger, debug = false }) {
    this._adapter = adapter;
    this._serializer = serializer;
    this._deserializer = deserializer;
    this._logger = logger;
    this._debug = debug;
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
        } catch (error) {
          if (error.code !== "ENOENT") {
            this._logger(`WARNING: Could not load collection "${name}": ${error.message}. Collection will be empty.`, "error");
          }
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
   * Write queue: concurrent saves for the same collection are coalesced.
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
   * @param {object} collections - Live collections map.
   * @returns {Promise<void>}
   */
  async saveDirty(collections) {
    const dirtyNames = Object.keys(collections).filter(name => collections[name]._dirty);
    if (dirtyNames.length === 0) return;
    await Promise.all(dirtyNames.map(name => this._saveOne(collections, name)));
  }

  /**
   * Atomic batch save of specific collections via writeAll().
   * Used by transactions to commit all touched collections atomically.
   *
   * @param {object} collections - Live collections map.
   * @param {string[]} names - Collection names to save.
   * @returns {Promise<void>}
   */
  async saveAtomic(collections, names) {
    if (names.length === 0) return;

    // Set flush sentinel and persist _meta BEFORE the batch so a crash
    // mid-batch leaves a detectable sentinel on disk.
    this._writeFlushSentinel(collections, names);
    await this._adapter.write("_meta", this._serializeCollection(collections["_meta"]));

    const entries = names
      .filter(n => n !== "_meta") // _meta already written above
      .map(name => ({ name, data: this._serializeCollection(collections[name]) }));

    try {
      if (entries.length > 0) await this._adapter.writeAll(entries);

      // Clear dirty flags and mark flush complete
      for (const name of names) {
        if (collections[name]) collections[name]._dirty = false;
      }
      this._clearFlushSentinel(collections);

      // Persist _meta again with completedAt so future loads see a clean state
      await this._adapter.write("_meta", this._serializeCollection(collections["_meta"]));
    } catch (error) {
      throw new PersistenceError(
        "ERR_SKALEX_PERSISTENCE_FLUSH_FAILED",
        `Atomic batch save failed: ${error.message}`,
        { collections: names }
      );
    }
  }

  /**
   * Mark a collection as dirty (needs persistence).
   * @param {object} collections
   * @param {string} name
   */
  markDirty(collections, name) {
    const col = collections[name];
    if (col) col._dirty = true;
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

  async _saveOne(collections, name) {
    const col = collections[name];
    if (!col) return;
    if (col.isSaving) {
      col._pendingSave = true;
      return;
    }
    col.isSaving = true;
    col._pendingSave = false;
    try {
      await this._adapter.write(name, this._serializeCollection(col));
      col._dirty = false;
    } catch (error) {
      this._logger(`Error saving "${name}": ${error.message}`, "error");
      throw error;
    } finally {
      col.isSaving = false;
    }
    if (col._pendingSave) {
      col._pendingSave = false;
      await this._saveOne(collections, name);
    }
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
    const metaDoc = metaCol.index.get("migrations");
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
   * Clean orphan temp files left by interrupted FsAdapter writes.
   * Only applies if the adapter has a list-level view that could include temp files.
   */
  async _cleanOrphanTempFiles() {
    // Only FsAdapter (and compatible) supports directory listing that might include temp files.
    // We detect this by checking for the ensureDir/join helpers.
    if (typeof this._adapter.join !== "function") return;
    if (typeof this._adapter.list !== "function") return;

    try {
      const nodeFs = await import("node:fs");
      const nodePath = await import("node:path");
      const dir = this._adapter.dir;
      if (!dir) return;

      const files = await nodeFs.default.promises.readdir(dir);
      const orphans = files.filter(f => f.includes(".tmp."));
      for (const orphan of orphans) {
        const orphanPath = nodePath.default.join(dir, orphan);
        try {
          await nodeFs.default.promises.unlink(orphanPath);
          this._log(`Cleaned orphan temp file: ${orphan}`);
        } catch { /* ignore cleanup failures */ }
      }
    } catch { /* ignore on non-FS runtimes */ }
  }

  _getOrCreateMeta(collections) {
    if (!collections["_meta"]) {
      collections["_meta"] = {
        collectionName: "_meta",
        data: [],
        index: new Map(),
        isSaving: false,
        _pendingSave: false,
        _dirty: false,
        schema: null,
        rawSchema: null,
        fieldIndex: null,
        changelog: false,
        softDelete: false,
        versioning: false,
        strict: false,
        onSchemaError: "throw",
        defaultTtl: null,
        defaultEmbed: null,
        maxDocs: null,
      };
    }
    const metaCol = collections["_meta"];
    let doc = metaCol.index.get("migrations");
    if (!doc) {
      doc = { _id: "migrations" };
      metaCol.data.push(doc);
      metaCol.index.set("migrations", doc);
    }
    return doc;
  }

  _log(msg) {
    if (this._debug) this._logger(msg, "info");
  }
}

export default PersistenceManager;
