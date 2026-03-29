const { generateUniqueId, logger } = require("./utils");
const { matchesFilter, presortFilter } = require("./query");
const { validateDoc } = require("./validator");
const { computeExpiry } = require("./ttl");

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

  // ─── Insert ──────────────────────────────────────────────────────────────

  /**
   * Insert a single document.
   * @param {object} item
   * @param {{ save?: boolean, ifNotExists?: boolean, ttl?: number|string }} [options]
   * @returns {Promise<{ data: object }>}
   */
  async insertOne(item, options = {}) {
    const { save, ifNotExists, ttl } = options;

    if (ifNotExists) {
      const existing = this._findRaw(item);
      if (existing) return { data: existing };
    }

    if (this._schema) {
      const errors = validateDoc(item, this._schema);
      if (errors.length) throw new Error(`Validation failed: ${errors.join("; ")}`);
    }

    const newItem = {
      _id: generateUniqueId(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...item,
    };

    if (ttl) newItem._expiresAt = computeExpiry(ttl);

    if (this._fieldIndex) this._fieldIndex.add(newItem);

    this._data.push(newItem);
    this._index.set(newItem._id, newItem);

    if (save) await this.database.saveData(this.name);

    return { data: newItem };
  }

  /**
   * Insert multiple documents.
   * @param {object[]} items
   * @param {{ save?: boolean, ttl?: number|string }} [options]
   * @returns {Promise<{ docs: object[] }>}
   */
  async insertMany(items, options = {}) {
    const { save, ttl } = options;

    const newItems = items.map(item => {
      if (this._schema) {
        const errors = validateDoc(item, this._schema);
        if (errors.length) throw new Error(`Validation failed: ${errors.join("; ")}`);
      }

      const newItem = {
        _id: generateUniqueId(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...item,
      };
      if (ttl) newItem._expiresAt = computeExpiry(ttl);
      return newItem;
    });

    if (this._fieldIndex) {
      for (const newItem of newItems) this._fieldIndex.add(newItem);
    }

    this._data.push(...newItems);
    for (const newItem of newItems) this._index.set(newItem._id, newItem);

    if (save) await this.database.saveData(this.name);

    return { docs: newItems };
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  /**
   * Update the first matching document.
   * @param {object} filter
   * @param {object} update
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<{ data: object }|null>}
   */
  async updateOne(filter, update, options = {}) {
    const item = this._findRaw(filter);
    if (!item) return null;

    if (this._fieldIndex) this._fieldIndex.remove(item);
    this.applyUpdate(item, update);
    if (this._fieldIndex) this._fieldIndex.add(item);

    if (options.save) await this.database.saveData(this.name);

    return { data: item };
  }

  /**
   * Update all matching documents.
   * @param {object} filter
   * @param {object} update
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<{ docs: object[] }>}
   */
  async updateMany(filter, update, options = {}) {
    const items = this._findAllRaw(filter);

    for (const item of items) {
      if (this._fieldIndex) this._fieldIndex.remove(item);
      this.applyUpdate(item, update);
      if (this._fieldIndex) this._fieldIndex.add(item);
    }

    if (options.save) await this.database.saveData(this.name);

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
    const { populate, select, sort, page = 1, limit } = options;

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
      return { docs: results, page, totalDocs, totalPages };
    }

    return { docs: results };
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  /**
   * Delete the first matching document.
   * @param {object} filter
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<{ data: object }|null>}
   */
  async deleteOne(filter, options = {}) {
    const index = this._findIndex(filter);
    if (index === -1) return null;

    const deletedItem = this._data.splice(index, 1)[0];
    this._index.delete(deletedItem._id);
    if (this._fieldIndex) this._fieldIndex.remove(deletedItem);

    if (options.save) await this.database.saveData(this.name);

    return { data: deletedItem };
  }

  /**
   * Delete all matching documents.
   * @param {object} filter
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<{ docs: object[] }>}
   */
  async deleteMany(filter, options = {}) {
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
