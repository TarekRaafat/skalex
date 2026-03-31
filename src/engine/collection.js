import { generateUniqueId } from "./utils.js";
import { matchesFilter, presortFilter } from "./query.js";
import { validateDoc, stripInvalidFields } from "./validator.js";
import { computeExpiry } from "./ttl.js";
import { cosineSimilarity, stripVector } from "./vector.js";
import { count as aggCount, sum as aggSum, avg as aggAvg, groupBy as aggGroupBy } from "../features/aggregation.js";

/**
 * Collection represents a collection of documents in the database.
 */
class Collection {
  /**
   * @param {object} collectionData - Internal store object managed by Skalex.
   * @param {Skalex} database - The parent Skalex instance.
   */
  constructor(collectionData, database) {
    this.name = collectionData.collectionName;
    this.database = database;
    this._store = collectionData;
  }

  get _data()  { return this._store.data; }
  set _data(val) { this._store.data = val; }
  get _index() { return this._store.index; }

  /** @returns {import("./indexes")|null} Secondary field index engine. */
  get _fieldIndex() { return this._store.fieldIndex || null; }

  /** @returns {Map<string, object>|null} Parsed schema fields. */
  get _schema() { return this._store.schema ? this._store.schema.fields : null; }

  /** @returns {boolean} Whether changelog is enabled for this collection. */
  get _changelogEnabled() { return this._store.changelog === true; }

  /** @returns {boolean} Whether soft-delete is enabled for this collection. */
  get _softDelete()    { return this._store.softDelete    === true; }

  /** @returns {boolean} Whether document versioning is enabled for this collection. */
  get _versioning()    { return this._store.versioning    === true; }

  /** @returns {boolean} Whether strict mode (reject unknown fields) is enabled. */
  get _strict()        { return this._store.strict        === true; }

  /** @returns {"throw"|"warn"|"strip"} Schema error handling strategy. */
  get _onSchemaError() { return this._store.onSchemaError ?? "throw"; }

  /** @returns {number|string|null} Default TTL applied to every inserted document. */
  get _defaultTtl()    { return this._store.defaultTtl   || null; }

  /** @returns {string|null} Default field to embed on every inserted document. */
  get _defaultEmbed()  { return this._store.defaultEmbed || null; }

  /** @returns {number|null} Maximum number of documents (capped collection). */
  get _maxDocs()       { return this._store.maxDocs       || null; }

  // ─── Insert ──────────────────────────────────────────────────────────────

  /**
   * Insert a single document.
   * @param {object} item
   * @param {{ save?: boolean, ifNotExists?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<object>}
   */
  async insertOne(item, options = {}) {
    await this.database._ensureConnected();
    const { save, ifNotExists, ttl, embed, session } = options;

    if (ifNotExists) {
      const existing = this._findRaw(item);
      if (existing) return existing;
    }

    const validated = this._applyValidation(item);

    await this.database._plugins.run("beforeInsert", { collection: this.name, doc: validated });

    const newItem = await this._buildDoc(validated, { ttl, embed });

    this._addToIndex(newItem);
    this._data.push(newItem);
    this._index.set(newItem._id, newItem);

    this._enforceCapAfterInsert();

    await this._saveIfNeeded(save);

    if (this._changelogEnabled) {
      await this.database._changeLog.log("insert", this.name, newItem, null, session || null);
    }

    this.database._sessionStats.recordWrite(session);
    this.database._eventBus.emit(this.name, { op: "insert", collection: this.name, doc: stripVector(newItem) });

    const doc = stripVector(newItem);
    await this.database._plugins.run("afterInsert", { collection: this.name, doc });
    return doc;
  }

  /**
   * Insert multiple documents.
   * @param {object[]} items
   * @param {{ save?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async insertMany(items, options = {}) {
    await this.database._ensureConnected();
    const { save, ttl, embed, session } = options;

    const newItems = [];
    for (const item of items) {
      const validated = this._applyValidation(item);
      await this.database._plugins.run("beforeInsert", { collection: this.name, doc: validated });
      newItems.push(await this._buildDoc(validated, { ttl, embed }));
    }

    for (const newItem of newItems) this._addToIndex(newItem);

    this._data.push(...newItems);
    for (const newItem of newItems) this._index.set(newItem._id, newItem);

    this._enforceCapAfterInsert();

    await this._saveIfNeeded(save);

    if (this._changelogEnabled) {
      for (const newItem of newItems) {
        await this.database._changeLog.log("insert", this.name, newItem, null, session || null);
      }
    }

    this.database._sessionStats.recordWrite(session);
    for (const newItem of newItems) {
      const stripped = stripVector(newItem);
      this.database._eventBus.emit(this.name, { op: "insert", collection: this.name, doc: stripped });
      await this.database._plugins.run("afterInsert", { collection: this.name, doc: stripped });
    }

    return newItems.map(stripVector);
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  /**
   * Update the first matching document.
   * @param {object} filter
   * @param {object} update
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object|null>}
   */
  async updateOne(filter, update, options = {}) {
    await this.database._ensureConnected();
    const { save, session } = options;
    await this.database._plugins.run("beforeUpdate", { collection: this.name, filter, update });

    const item = this._findRaw(filter);
    if (!item) return null;

    const prev = this._changelogEnabled ? { ...item } : null;
    const oldDoc = this._fieldIndex ? { ...item } : null;

    this.applyUpdate(item, update);
    this._updateInIndex(oldDoc, item);

    await this._saveIfNeeded(save);

    if (this._changelogEnabled) {
      await this.database._changeLog.log("update", this.name, item, prev, session || null);
    }

    this.database._sessionStats.recordWrite(session);
    this.database._eventBus.emit(this.name, { op: "update", collection: this.name, doc: stripVector(item), prev });

    await this.database._plugins.run("afterUpdate", { collection: this.name, filter, update, result: item });
    return stripVector(item);
  }

  /**
   * Update all matching documents.
   * @param {object} filter
   * @param {object} update
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async updateMany(filter, update, options = {}) {
    await this.database._ensureConnected();
    const { save, session } = options;
    await this.database._plugins.run("beforeUpdate", { collection: this.name, filter, update });

    const items = this._findAllRaw(filter);
    const prevs = this._changelogEnabled ? items.map(d => ({ ...d })) : null;
    const oldDocs = this._fieldIndex ? items.map(d => ({ ...d })) : null;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      this.applyUpdate(item, update);
      this._updateInIndex(oldDocs?.[i], item);
    }

    await this._saveIfNeeded(save);

    if (this._changelogEnabled) {
      for (let i = 0; i < items.length; i++) {
        await this.database._changeLog.log("update", this.name, items[i], prevs[i], session || null);
      }
    }

    this.database._sessionStats.recordWrite(session);
    for (const item of items) {
      this.database._eventBus.emit(this.name, { op: "update", collection: this.name, doc: stripVector(item) });
    }

    await this.database._plugins.run("afterUpdate", { collection: this.name, filter, update, result: items });
    return items.map(stripVector);
  }

  /**
   * Apply an update descriptor to a document in place.
   * Supports $inc, $push, and direct assignment. Increments _version when versioning is on.
   * @param {object} item
   * @param {object} update
   * @returns {object} The mutated document.
   */
  applyUpdate(item, update) {
    for (const field in update) {
      if (field === "__proto__" || field === "constructor" || field === "prototype") continue;
      const updateValue = update[field];

      if (Array.isArray(updateValue)) {
        // Direct array assignment — must come before the generic object check
        // because for...in on [] yields zero iterations and the value would be lost.
        item[field] = updateValue;
      } else if (typeof updateValue === "object" && updateValue !== null) {
        for (const key in updateValue) {
          if (key === "$inc" && typeof item[field] === "number") {
            item[field] += updateValue[key];
          } else if (key === "$push") {
            // Auto-initialise the field as an array if it doesn't exist yet.
            if (!Array.isArray(item[field])) item[field] = [];
            item[field].push(updateValue[key]);
          } else if (!key.startsWith("$")) {
            item[field] = updateValue;
          }
        }
      } else {
        item[field] = updateValue;
      }
    }

    item.updatedAt = new Date();
    if (this._versioning) item._version = (item._version ?? 0) + 1;
    this._index.set(item._id, item);

    return item;
  }

  // ─── Upsert ──────────────────────────────────────────────────────────────

  /**
   * Update the first matching document, or insert if none exists.
   * @param {object} filter
   * @param {object} doc
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async upsert(filter, doc, options = {}) {
    const existing = this._findRaw(filter);
    if (existing) {
      return this.updateOne(filter, doc, options);
    }
    return this.insertOne({ ...filter, ...doc }, options);
  }

  /**
   * Batch upsert: for each doc in `docs`, match on `matchKey` and update or insert.
   * A single save is issued at the end (honouring autoSave).
   * @param {object[]} docs
   * @param {string} matchKey
   * @param {{ save?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async upsertMany(docs, matchKey, options = {}) {
    await this.database._ensureConnected();
    const { save, ...rest } = options;

    const results = [];
    for (const doc of docs) {
      results.push(await this.upsert({ [matchKey]: doc[matchKey] }, doc, { ...rest, save: false }));
    }

    await this._saveIfNeeded(save);
    return results;
  }

  // ─── Soft-delete restore ──────────────────────────────────────────────────

  /**
   * Restore a soft-deleted document (undo a soft delete).
   * Requires the collection to have softDelete enabled.
   * @param {object} filter
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object|null>}
   */
  async restore(filter, options = {}) {
    if (!this._softDelete) throw new Error(`restore() requires softDelete on "${this.name}"`);
    await this.database._ensureConnected();
    const { save, session } = options;

    const item = this._findRaw(filter, { includeDeleted: true });
    if (!item || !item._deletedAt) return null;

    delete item._deletedAt;
    item.updatedAt = new Date();
    this._index.set(item._id, item);

    await this._saveIfNeeded(save);

    if (this._changelogEnabled) {
      await this.database._changeLog.log("restore", this.name, item, null, session || null);
    }

    this.database._sessionStats.recordWrite(session);
    this.database._eventBus.emit(this.name, { op: "restore", collection: this.name, doc: stripVector(item) });
    return stripVector(item);
  }

  // ─── Watch ───────────────────────────────────────────────────────────────

  /**
   * Watch for mutation events on this collection.
   *
   * Callback form — returns an unsubscribe function:
   *   const unsub = col.watch({ status: "active" }, event => console.log(event));
   *   unsub(); // stop watching
   *
   * AsyncIterator form — no callback:
   *   for await (const event of col.watch({ status: "active" })) { ... }
   *
   * Event shape: { op: "insert"|"update"|"delete"|"restore", collection, doc, prev? }
   *
   * @param {object|Function} [filter]
   * @param {Function} [callback]
   * @returns {(() => void)|AsyncIterableIterator}
   */
  watch(filter, callback) {
    // watch(callback) shorthand — no filter
    if (typeof filter === "function") { callback = filter; filter = null; }

    if (callback) {
      // Callback-based API — returns unsub fn
      return this.database._eventBus.on(this.name, event => {
        if (!filter || matchesFilter(event.doc, filter)) callback(event);
      });
    }

    // AsyncIterator API
    return this._watchIterator(filter);
  }

  _watchIterator(filter) {
    const queue   = [];
    let   resolve = null;
    let   done    = false;

    const unsub = this.database._eventBus.on(this.name, event => {
      if (filter && !matchesFilter(event.doc, filter)) return;
      if (resolve) {
        const r = resolve; resolve = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
    });

    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
        if (done)             return Promise.resolve({ value: undefined, done: true });
        return new Promise(res => { resolve = res; });
      },
      return() {
        done = true; unsub();
        if (resolve) { const r = resolve; resolve = null; r({ value: undefined, done: true }); }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  // ─── Aggregation ─────────────────────────────────────────────────────────

  /**
   * Count documents matching a filter.
   * @param {object} [filter={}]
   * @returns {Promise<number>}
   */
  async count(filter = {}) {
    return aggCount(this._findAllRaw(filter));
  }

  /**
   * Sum a numeric field across matching documents.
   * @param {string} field
   * @param {object} [filter={}]
   * @returns {Promise<number>}
   */
  async sum(field, filter = {}) {
    return aggSum(this._findAllRaw(filter), field);
  }

  /**
   * Average a numeric field across matching documents.
   * Returns null when no matching numeric values exist.
   * @param {string} field
   * @param {object} [filter={}]
   * @returns {Promise<number|null>}
   */
  async avg(field, filter = {}) {
    return aggAvg(this._findAllRaw(filter), field);
  }

  /**
   * Group matching documents by a field value.
   * Returns `{ [value]: docs[] }`.
   * @param {string} field
   * @param {object} [filter={}]
   * @returns {Promise<Record<string, object[]>>}
   */
  async groupBy(field, filter = {}) {
    return aggGroupBy(this._findAllRaw(filter), field);
  }

  // ─── Find ─────────────────────────────────────────────────────────────────

  /**
   * Find the first matching document (returns a shallow copy with projection).
   * @param {object} filter
   * @param {{ populate?: string[], select?: string[], includeDeleted?: boolean }} [options]
   * @returns {Promise<object|null>}
   */
  async findOne(filter, options = {}) {
    await this.database._ensureConnected();
    const { populate, select, includeDeleted = false } = options;
    const item = this._findRaw(filter, { includeDeleted });
    if (!item) return null;

    const newItem = this._projectDoc(item, select);
    if (populate) await this._populateDoc(newItem, item, populate);
    return newItem;
  }

  /**
   * Find all matching documents.
   * @param {object} filter
   * @param {{ populate?: string[], select?: string[], sort?: object, page?: number, limit?: number, includeDeleted?: boolean }} [options]
   * @returns {Promise<{ docs: object[], page?: number, totalDocs?: number, totalPages?: number }>}
   */
  async find(filter, options = {}) {
    await this.database._ensureConnected();
    const _t0 = Date.now();
    const { populate, select, sort, page = 1, limit, session, includeDeleted = false } = options;

    await this.database._plugins.run("beforeFind", { collection: this.name, filter, options });

    const candidates = this._getCandidates(filter);
    const sortedFilter = presortFilter(
      filter,
      this._fieldIndex ? this._fieldIndex.indexedFields : new Set()
    );

    let results = [];

    for (const item of candidates) {
      if (this._softDelete && item._deletedAt && !includeDeleted) continue;
      if (!matchesFilter(item, sortedFilter)) continue;
      const newItem = this._projectDoc(item, select);
      if (populate) await this._populateDoc(newItem, item, populate);
      results.push(newItem);
    }

    if (sort) {
      const sortFields = Object.keys(sort);
      results.sort((a, b) => {
        for (const field of sortFields) {
          const dir = sort[field]; // 1 = ascending, -1 = descending
          if (a[field] < b[field]) return -dir;
          if (a[field] > b[field]) return dir;
        }
        return 0;
      });
    }

    let extra;
    if (limit) {
      const totalDocs = results.length;
      const totalPages = Math.ceil(totalDocs / limit);
      const startIndex = (page - 1) * limit;
      results = results.slice(startIndex, startIndex + limit);
      extra = { page, totalDocs, totalPages };
    }

    this.database._queryLog?.record({ collection: this.name, op: "find", filter, duration: Date.now() - _t0, resultCount: results.length });
    this.database._sessionStats.recordRead(session);
    await this.database._plugins.run("afterFind", { collection: this.name, filter, options, docs: results });
    return extra ? { docs: results, ...extra } : { docs: results };
  }

  // ─── Vector Search ───────────────────────────────────────────────────────

  /**
   * Semantic similarity search — embed a query string and rank all documents
   * with a `_vector` field by cosine similarity.
   *
   * @param {string} query
   * @param {{ filter?: object, limit?: number, minScore?: number }} [options]
   * @returns {Promise<{ docs: object[], scores: number[] }>}
   */
  async search(query, { filter, limit = 10, minScore = 0, session } = {}) {
    await this.database._ensureConnected();
    const _t0 = Date.now();
    await this.database._plugins.run("beforeSearch", { collection: this.name, query, options: { filter, limit, minScore } });
    const queryVector = await this.database.embed(query);

    const candidates = filter ? this._findAllRaw(filter) : this._data;

    const scored = [];
    for (const doc of candidates) {
      if (!doc._vector) continue;
      const score = cosineSimilarity(queryVector, doc._vector);
      if (score >= minScore) scored.push({ doc, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    this.database._queryLog?.record({ collection: this.name, op: "search", query, duration: Date.now() - _t0, resultCount: top.length });
    this.database._sessionStats.recordRead(session);

    const docs = top.map(r => stripVector(r.doc));
    const scores = top.map(r => r.score);
    await this.database._plugins.run("afterSearch", { collection: this.name, query, options: { filter, limit, minScore }, docs, scores });

    return { docs, scores };
  }

  /**
   * Find the nearest neighbours to an existing document by `_id`.
   *
   * @param {string} id
   * @param {{ limit?: number, minScore?: number }} [options]
   * @returns {Promise<{ docs: object[], scores: number[] }>}
   */
  async similar(id, { limit = 10, minScore = 0 } = {}) {
    await this.database._ensureConnected();
    const source = this._index.get(id);
    if (!source || !source._vector) return { docs: [], scores: [] };

    const scored = [];
    for (const doc of this._data) {
      if (doc._id === id || !doc._vector) continue;
      const score = cosineSimilarity(source._vector, doc._vector);
      if (score >= minScore) scored.push({ doc, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    return {
      docs: top.map(r => stripVector(r.doc)),
      scores: top.map(r => r.score),
    };
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  /**
   * Delete the first matching document.
   * When softDelete is enabled, sets `_deletedAt` instead of removing the document.
   * @param {object} filter
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object|null>}
   */
  async deleteOne(filter, options = {}) {
    await this.database._ensureConnected();
    const { save, session } = options;
    await this.database._plugins.run("beforeDelete", { collection: this.name, filter });

    if (this._softDelete) {
      const item = this._findRaw(filter);
      if (!item) return null;

      item._deletedAt = new Date();
      item.updatedAt  = new Date();
      this._index.set(item._id, item);

      await this._saveIfNeeded(save);

      if (this._changelogEnabled) {
        await this.database._changeLog.log("delete", this.name, item, null, session || null);
      }

      this.database._sessionStats.recordWrite(session);
      this.database._eventBus.emit(this.name, { op: "delete", collection: this.name, doc: stripVector(item) });

      await this.database._plugins.run("afterDelete", { collection: this.name, filter, result: item });
      return stripVector(item);
    }

    const index = this._findIndex(filter);
    if (index === -1) return null;

    const deletedItem = this._data.splice(index, 1)[0];
    this._index.delete(deletedItem._id);
    this._removeFromIndex(deletedItem);

    await this._saveIfNeeded(save);

    if (this._changelogEnabled) {
      await this.database._changeLog.log("delete", this.name, deletedItem, null, session || null);
    }

    this.database._sessionStats.recordWrite(session);
    this.database._eventBus.emit(this.name, { op: "delete", collection: this.name, doc: stripVector(deletedItem) });

    await this.database._plugins.run("afterDelete", { collection: this.name, filter, result: deletedItem });
    return stripVector(deletedItem);
  }

  /**
   * Delete all matching documents.
   * When softDelete is enabled, sets `_deletedAt` instead of removing documents.
   * @param {object} filter
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async deleteMany(filter, options = {}) {
    await this.database._ensureConnected();
    const { save, session } = options;
    await this.database._plugins.run("beforeDelete", { collection: this.name, filter });

    if (this._softDelete) {
      const items = this._findAllRaw(filter);
      const now = new Date();
      for (const item of items) {
        item._deletedAt = now;
        item.updatedAt  = now;
        this._index.set(item._id, item);
      }

      await this._saveIfNeeded(save);

      if (this._changelogEnabled) {
        for (const item of items) {
          await this.database._changeLog.log("delete", this.name, item, null, session || null);
        }
      }

      this.database._sessionStats.recordWrite(session);
      for (const item of items) {
        this.database._eventBus.emit(this.name, { op: "delete", collection: this.name, doc: stripVector(item) });
      }

      await this.database._plugins.run("afterDelete", { collection: this.name, filter, result: items });
      return items.map(stripVector);
    }

    const deletedItems = [];
    const remainingItems = [];

    for (const item of this._data) {
      if (matchesFilter(item, filter)) {
        deletedItems.push(item);
        this._index.delete(item._id);
        this._removeFromIndex(item);
      } else {
        remainingItems.push(item);
      }
    }

    this._data = remainingItems;

    await this._saveIfNeeded(save);

    if (this._changelogEnabled) {
      for (const deletedItem of deletedItems) {
        await this.database._changeLog.log("delete", this.name, deletedItem, null, session || null);
      }
    }

    this.database._sessionStats.recordWrite(session);
    for (const deletedItem of deletedItems) {
      this.database._eventBus.emit(this.name, { op: "delete", collection: this.name, doc: stripVector(deletedItem) });
    }

    await this.database._plugins.run("afterDelete", { collection: this.name, filter, result: deletedItems });
    return deletedItems.map(stripVector);
  }

  // ─── Export ──────────────────────────────────────────────────────────────

  /**
   * Export filtered data to a file via the storage adapter.
   * @param {object} [filter={}]
   * @param {{ dir?: string, name?: string, format?: "json"|"csv" }} [options]
   */
  async export(filter = {}, options = {}) {
    const { dir, name, format = "json" } = options;

    try {
      const filteredData = this._data.filter(item => matchesFilter(item, filter));

      if (filteredData.length === 0) {
        throw new Error(`export(): no documents matched the filter in "${this.name}"`);
      }

      let content;
      if (format === "json") {
        content = JSON.stringify(filteredData, null, 2);
      } else {
        const header = Object.keys(filteredData[0]).join(",");
        const rows = filteredData.map(item =>
          Object.values(item).map(v =>
            typeof v === "string" && v.includes(",") ? `"${v}"` : v
          ).join(",")
        );
        content = [header, ...rows].join("\n");
      }

      if (typeof this.database.fs.writeRaw !== "function") {
        throw new Error(
          `export() requires a file-system adapter (FsAdapter). ` +
          `The current adapter does not support raw file writes.`
        );
      }

      const exportDir = dir || `${this.database.dataDirectory}/exports`;
      const fileName = `${name || this.name}.${format}`;
      const filePath = this.database.fs.join(exportDir, fileName);

      this.database.fs.ensureDir(exportDir);
      await this.database.fs.writeRaw(filePath, content);
    } catch (error) {
      this.database._logger(`Error exporting "${this.name}": ${error.message}`, "error");
      throw error;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Save if `save` is explicitly true, or if database-level autoSave is on.
   * Pass `save: false` to opt out even when autoSave is enabled.
   * @param {boolean|undefined} save
   */
  async _saveIfNeeded(save) {
    if (save ?? this.database._autoSave) await this.database.saveData(this.name);
  }

  /**
   * Validate a document against the collection schema, applying the configured
   * error strategy: "throw" (default), "warn" (log and proceed), "strip" (remove
   * invalid fields). Returns the doc (possibly stripped) or throws on failure.
   * @param {object} item
   * @returns {object}
   */
  _applyValidation(item) {
    if (!this._schema) return item;
    const errors = validateDoc(item, this._schema, this._strict);
    if (!errors.length) return item;
    switch (this._onSchemaError) {
      case "warn":
        this.database._logger(`[${this.name}] Validation warning: ${errors.join("; ")}`, "warn");
        return item;
      case "strip":
        return stripInvalidFields(item, this._schema);
      default:
        throw new Error(`Validation failed: ${errors.join("; ")}`);
    }
  }

  /**
   * Evict oldest documents when the collection exceeds `maxDocs`.
   * FIFO: the earliest-inserted documents are removed first.
   */
  _enforceCapAfterInsert() {
    const max = this._maxDocs;
    if (!max || this._data.length <= max) return;
    const toEvict = this._data.splice(0, this._data.length - max);
    for (const doc of toEvict) {
      this._index.delete(doc._id);
      this._removeFromIndex(doc);
    }
  }

  _findRaw(filter, { includeDeleted = false } = {}) {
    if (typeof filter === "function") {
      for (const doc of this._data) {
        if (this._softDelete && doc._deletedAt && !includeDeleted) continue;
        if (filter(doc)) return doc;
      }
      return null;
    }
    if (filter._id) {
      const item = this._index.get(filter._id) || null;
      if (!item) return null;
      if (this._softDelete && item._deletedAt && !includeDeleted) return null;
      if (Object.keys(filter).length > 1) {
        return matchesFilter(item, filter) ? item : null;
      }
      return item;
    }

    // Try O(1) indexed field lookup first
    if (this._fieldIndex) {
      for (const key in filter) {
        const val = filter[key];
        if (typeof val !== "object" || val === null) {
          const candidates = this._fieldIndex.lookup(key, val);
          if (candidates !== null) {
            for (const doc of candidates) {
              if (this._softDelete && doc._deletedAt && !includeDeleted) continue;
              if (matchesFilter(doc, filter)) return doc;
            }
            return null;
          }
        }
      }
    }

    for (const doc of this._data) {
      if (this._softDelete && doc._deletedAt && !includeDeleted) continue;
      if (matchesFilter(doc, filter)) return doc;
    }
    return null;
  }

  _findAllRaw(filter, { includeDeleted = false } = {}) {
    if (filter && typeof filter !== "function" && filter._id) {
      const item = this._index.get(filter._id);
      if (!item) return [];
      if (this._softDelete && item._deletedAt && !includeDeleted) return [];
      return matchesFilter(item, filter) ? [item] : [];
    }
    const results = [];
    for (const doc of this._getCandidates(filter)) {
      if (this._softDelete && doc._deletedAt && !includeDeleted) continue;
      if (matchesFilter(doc, filter)) results.push(doc);
    }
    return results;
  }

  _getCandidates(filter) {
    if (!this._fieldIndex) return this._data;
    for (const key in filter) {
      const val = filter[key];
      if (typeof val !== "object" || val === null) {
        const candidates = this._fieldIndex.lookup(key, val);
        if (candidates !== null) return candidates;
      }
    }
    return this._data;
  }

  _findIndex(filter) {
    for (let i = 0; i < this._data.length; i++) {
      if (matchesFilter(this._data[i], filter)) return i;
    }
    return -1;
  }

  // ─── Private index helpers ────────────────────────────────────────────────

  _addToIndex(doc) {
    if (this._fieldIndex) this._fieldIndex.add(doc);
  }

  _removeFromIndex(doc) {
    if (this._fieldIndex) this._fieldIndex.remove(doc);
  }

  _updateInIndex(oldDoc, doc) {
    if (this._fieldIndex) this._fieldIndex.update(oldDoc, doc);
  }

  // ─── Private document construction ───────────────────────────────────────

  /**
   * Build a new document from a raw item: assign _id/timestamps, apply TTL,
   * embed vector, and set initial _version when versioning is on.
   * @param {object} item
   * @param {{ ttl?: number|string, embed?: string|Function }} [opts]
   * @returns {Promise<object>}
   */
  async _buildDoc(item, { ttl, embed } = {}) {
    const newItem = {
      _id: (this.database._idGenerator ?? generateUniqueId)(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...item,
    };

    const resolvedTtl = ttl ?? this._defaultTtl;
    if (resolvedTtl) newItem._expiresAt = computeExpiry(resolvedTtl);

    const resolvedEmbed = embed ?? this._defaultEmbed;
    if (resolvedEmbed) {
      const text = typeof resolvedEmbed === "function" ? resolvedEmbed(newItem) : newItem[resolvedEmbed];
      newItem._vector = await this.database.embed(String(text));
    }

    if (this._versioning) newItem._version = 1;

    return newItem;
  }

  // ─── Private projection / population helpers ──────────────────────────────

  /**
   * Return a shallow copy of doc with optional field projection.
   * Strips _vector when no select is given.
   * @param {object} doc
   * @param {string[]|undefined} select
   * @returns {object}
   */
  _projectDoc(doc, select) {
    if (select) {
      const out = {};
      for (const field of select) out[field] = doc[field];
      return out;
    }
    const out = { ...doc };
    delete out._vector;
    return out;
  }

  /**
   * Populate foreign-key fields on an already-projected document.
   * Mutates `out` in place.
   * @param {object} out     - The projected doc to populate into.
   * @param {object} source  - The raw doc holding the FK values.
   * @param {string[]} fields
   * @returns {Promise<void>}
   */
  async _populateDoc(out, source, fields) {
    for (const field of fields) {
      const related = this.database.useCollection(field);
      const item = await related.findOne({ _id: source[field] });
      if (item) out[field] = item;
    }
  }
}

export default Collection;
