const { generateUniqueId, logger } = require("./utils");
const { matchesFilter, presortFilter } = require("./query");
const { validateDoc } = require("./validator");
const { computeExpiry } = require("./ttl");
const { cosineSimilarity, stripVector } = require("./vector");
const { count: aggCount, sum: aggSum, avg: aggAvg, groupBy: aggGroupBy } = require("./aggregation");

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

  // ─── Insert ──────────────────────────────────────────────────────────────

  /**
   * Insert a single document.
   * @param {object} item
   * @param {{ save?: boolean, ifNotExists?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<{ data: object }>}
   */
  async insertOne(item, options = {}) {
    const { save, ifNotExists, ttl, embed, session } = options;

    if (ifNotExists) {
      const existing = this._findRaw(item);
      if (existing) return { data: existing };
    }

    if (this._schema) {
      const errors = validateDoc(item, this._schema);
      if (errors.length) throw new Error(`Validation failed: ${errors.join("; ")}`);
    }

    await this.database._plugins.run("beforeInsert", { collection: this.name, doc: item });

    const newItem = {
      _id: generateUniqueId(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...item,
    };

    if (ttl) newItem._expiresAt = computeExpiry(ttl);

    if (embed) {
      const text = typeof embed === "function" ? embed(newItem) : newItem[embed];
      newItem._vector = await this.database.embed(String(text));
    }

    if (this._fieldIndex) this._fieldIndex.add(newItem);

    this._data.push(newItem);
    this._index.set(newItem._id, newItem);

    if (save) await this.database.saveData(this.name);

    if (this._changelogEnabled) {
      await this.database._changeLog.log("insert", this.name, newItem, null, session || null);
    }

    this.database._sessionStats.recordWrite(session);
    this.database._eventBus.emit(this.name, { op: "insert", collection: this.name, doc: stripVector(newItem) });

    const result = { data: stripVector(newItem) };
    await this.database._plugins.run("afterInsert", { collection: this.name, doc: result.data });
    return result;
  }

  /**
   * Insert multiple documents.
   * @param {object[]} items
   * @param {{ save?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<{ docs: object[] }>}
   */
  async insertMany(items, options = {}) {
    const { save, ttl, embed, session } = options;

    const newItems = [];
    for (const item of items) {
      if (this._schema) {
        const errors = validateDoc(item, this._schema);
        if (errors.length) throw new Error(`Validation failed: ${errors.join("; ")}`);
      }

      await this.database._plugins.run("beforeInsert", { collection: this.name, doc: item });

      const newItem = {
        _id: generateUniqueId(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...item,
      };

      if (ttl) newItem._expiresAt = computeExpiry(ttl);

      if (embed) {
        const text = typeof embed === "function" ? embed(newItem) : newItem[embed];
        newItem._vector = await this.database.embed(String(text));
      }

      newItems.push(newItem);
    }

    if (this._fieldIndex) {
      for (const newItem of newItems) this._fieldIndex.add(newItem);
    }

    this._data.push(...newItems);
    for (const newItem of newItems) this._index.set(newItem._id, newItem);

    if (save) await this.database.saveData(this.name);

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

    return { docs: newItems.map(stripVector) };
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  /**
   * Update the first matching document.
   * @param {object} filter
   * @param {object} update
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<{ data: object }|null>}
   */
  async updateOne(filter, update, options = {}) {
    await this.database._plugins.run("beforeUpdate", { collection: this.name, filter, update });

    const item = this._findRaw(filter);
    if (!item) return null;

    const prev = this._changelogEnabled ? { ...item } : null;

    if (this._fieldIndex) this._fieldIndex.remove(item);
    this.applyUpdate(item, update);
    if (this._fieldIndex) this._fieldIndex.add(item);

    if (options.save) await this.database.saveData(this.name);

    if (this._changelogEnabled) {
      await this.database._changeLog.log("update", this.name, item, prev, options.session || null);
    }

    this.database._sessionStats.recordWrite(options.session);
    this.database._eventBus.emit(this.name, { op: "update", collection: this.name, doc: item, prev });

    const result = { data: item };
    await this.database._plugins.run("afterUpdate", { collection: this.name, filter, update, result: item });
    return result;
  }

  /**
   * Update all matching documents.
   * @param {object} filter
   * @param {object} update
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<{ docs: object[] }>}
   */
  async updateMany(filter, update, options = {}) {
    await this.database._plugins.run("beforeUpdate", { collection: this.name, filter, update });

    const items = this._findAllRaw(filter);
    const prevs = this._changelogEnabled ? items.map(d => ({ ...d })) : null;

    for (const item of items) {
      if (this._fieldIndex) this._fieldIndex.remove(item);
      this.applyUpdate(item, update);
      if (this._fieldIndex) this._fieldIndex.add(item);
    }

    if (options.save) await this.database.saveData(this.name);

    if (this._changelogEnabled) {
      for (let i = 0; i < items.length; i++) {
        await this.database._changeLog.log("update", this.name, items[i], prevs[i], options.session || null);
      }
    }

    this.database._sessionStats.recordWrite(options.session);
    for (const item of items) {
      this.database._eventBus.emit(this.name, { op: "update", collection: this.name, doc: item });
    }

    await this.database._plugins.run("afterUpdate", { collection: this.name, filter, update, result: items });
    return { docs: items };
  }

  /**
   * Apply an update descriptor to a document in place.
   * Supports $inc, $push, and direct assignment.
   * @param {object} item
   * @param {object} update
   * @returns {object} The mutated document.
   */
  applyUpdate(item, update) {
    for (const field in update) {
      const updateValue = update[field];

      if (typeof updateValue === "object" && updateValue !== null) {
        for (const key in updateValue) {
          if (key === "$inc" && typeof item[field] === "number") {
            item[field] += updateValue[key];
          } else if (key === "$push" && Array.isArray(item[field])) {
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
    this._index.set(item._id, item);

    return item;
  }

  // ─── Upsert ──────────────────────────────────────────────────────────────

  /**
   * Update the first matching document, or insert if none exists.
   * @param {object} filter
   * @param {object} doc
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<{ data: object }>}
   */
  async upsert(filter, doc, options = {}) {
    const existing = this._findRaw(filter);
    if (existing) {
      return this.updateOne(filter, doc, options);
    }
    return this.insertOne({ ...filter, ...doc }, options);
  }

  // ─── Find ─────────────────────────────────────────────────────────────────

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
   * Event shape: { op: "insert"|"update"|"delete", collection, doc, prev? }
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
   * @param {{ populate?: string[], select?: string[] }} [options]
   * @returns {Promise<object|null>}
   */
  async findOne(filter, options = {}) {
    const { populate, select } = options;
    const item = this._findRaw(filter);
    if (!item) return null;

    const newItem = {};

    if (populate) {
      for (const field of populate) {
        const relatedCollection = this.database.useCollection(field);
        const relatedItem = await relatedCollection.findOne({ _id: item[field] });
        if (relatedItem) newItem[field] = relatedItem;
      }
    }

    if (select) {
      for (const field of select) newItem[field] = item[field];
    } else {
      Object.assign(newItem, item);
      delete newItem._vector;
    }

    return newItem;
  }

  /**
   * Find all matching documents.
   * @param {object} filter
   * @param {{ populate?: string[], select?: string[], sort?: object, page?: number, limit?: number }} [options]
   * @returns {Promise<{ docs: object[], page?: number, totalDocs?: number, totalPages?: number }>}
   */
  async find(filter, options = {}) {
    const _t0 = Date.now();
    const { populate, select, sort, page = 1, limit, session } = options;

    await this.database._plugins.run("beforeFind", { collection: this.name, filter, options });

    const candidates = this._getCandidates(filter);
    const sortedFilter = presortFilter(
      filter,
      this._fieldIndex ? this._fieldIndex.indexedFields : new Set()
    );

    let results = [];

    for (const item of candidates) {
      if (!matchesFilter(item, sortedFilter)) continue;

      const newItem = {};

      if (populate) {
        for (const field of populate) {
          const relatedCollection = this.database.useCollection(field);
          const relatedItem = await relatedCollection.findOne({ [field]: item[field] });
          if (relatedItem) newItem[field] = relatedItem;
        }
      }

      if (select) {
        for (const field of select) newItem[field] = item[field];
      } else {
        Object.assign(newItem, item);
        delete newItem._vector;
      }

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

    if (limit) {
      const totalDocs = results.length;
      const totalPages = Math.ceil(totalDocs / limit);
      const startIndex = (page - 1) * limit;
      results = results.slice(startIndex, startIndex + limit);
      this.database._queryLog?.record({ collection: this.name, op: "find", filter, duration: Date.now() - _t0, resultCount: results.length });
      this.database._sessionStats.recordRead(session);
      await this.database._plugins.run("afterFind", { collection: this.name, filter, options, docs: results });
      return { docs: results, page, totalDocs, totalPages };
    }

    this.database._queryLog?.record({ collection: this.name, op: "find", filter, duration: Date.now() - _t0, resultCount: results.length });
    this.database._sessionStats.recordRead(session);
    await this.database._plugins.run("afterFind", { collection: this.name, filter, options, docs: results });
    return { docs: results };
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
   * @param {object} filter
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<{ data: object }|null>}
   */
  async deleteOne(filter, options = {}) {
    await this.database._plugins.run("beforeDelete", { collection: this.name, filter });

    const index = this._findIndex(filter);
    if (index === -1) return null;

    const deletedItem = this._data.splice(index, 1)[0];
    this._index.delete(deletedItem._id);
    if (this._fieldIndex) this._fieldIndex.remove(deletedItem);

    if (options.save) await this.database.saveData(this.name);

    if (this._changelogEnabled) {
      await this.database._changeLog.log("delete", this.name, deletedItem, null, options.session || null);
    }

    this.database._sessionStats.recordWrite(options.session);
    this.database._eventBus.emit(this.name, { op: "delete", collection: this.name, doc: deletedItem });

    await this.database._plugins.run("afterDelete", { collection: this.name, filter, result: deletedItem });
    return { data: deletedItem };
  }

  /**
   * Delete all matching documents.
   * @param {object} filter
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<{ docs: object[] }>}
   */
  async deleteMany(filter, options = {}) {
    await this.database._plugins.run("beforeDelete", { collection: this.name, filter });

    const deletedItems = [];
    const remainingItems = [];

    for (const item of this._data) {
      if (matchesFilter(item, filter)) {
        deletedItems.push(item);
        this._index.delete(item._id);
        if (this._fieldIndex) this._fieldIndex.remove(item);
      } else {
        remainingItems.push(item);
      }
    }

    this._data = remainingItems;

    if (options.save) await this.database.saveData(this.name);

    if (this._changelogEnabled) {
      for (const deletedItem of deletedItems) {
        await this.database._changeLog.log("delete", this.name, deletedItem, null, options.session || null);
      }
    }

    this.database._sessionStats.recordWrite(options.session);
    for (const deletedItem of deletedItems) {
      this.database._eventBus.emit(this.name, { op: "delete", collection: this.name, doc: deletedItem });
    }

    await this.database._plugins.run("afterDelete", { collection: this.name, filter, result: deletedItems });
    return { docs: deletedItems };
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

      const exportDir = dir || `${this.database.dataDirectory}/exports`;
      const fileName = `${name || this.name}.${format}`;
      const filePath = this.database.fs.join(exportDir, fileName);

      this.database.fs.ensureDir(exportDir);
      await this.database.fs.writeRaw(filePath, content);
    } catch (error) {
      logger(`Error exporting "${this.name}": ${error.message}`, "error");
      throw error;
    }
  }

  // ─── Backward-compat aliases ─────────────────────────────────────────────

  /** @deprecated Use query.matchesFilter directly. Kept for backward compat. */
  matchesFilter(item, filter) {
    return matchesFilter(item, filter);
  }

  /** @deprecated Use _findIndex internally. Kept for backward compat. */
  findIndex(filter) {
    return this._findIndex(filter);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  _findRaw(filter) {
    if (filter._id) {
      const item = this._index.get(filter._id) || null;
      if (item && Object.keys(filter).length > 1) {
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
              if (matchesFilter(doc, filter)) return doc;
            }
            return null;
          }
        }
      }
    }

    for (const doc of this._data) {
      if (matchesFilter(doc, filter)) return doc;
    }
    return null;
  }

  _findAllRaw(filter) {
    const results = [];
    for (const doc of this._getCandidates(filter)) {
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
}

module.exports = Collection;
