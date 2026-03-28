const { generateUniqueId, logger } = require("./utils");

/**
 * Collection represents a collection of documents in the database.
 * @class
 */
class Collection {
  /**
   * Creates an instance of Collection.
   * @param {object} collectionData - The data of the collection.
   * @param {Skalex} database - The Skalex database instance.
   */
  constructor(collectionData, database) {
    this.name = collectionData.collectionName;
    this.database = database;
    this._store = collectionData;
  }

  get _data()  { return this._store.data; }
  set _data(val) { this._store.data = val; }
  get _index() { return this._store.index; }

  /**
   * Inserts a single document into the collection.
   * @param {object} item - The document to insert.
   * @param {object} options - The options for the insert operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object} An object containing the inserted document.
   */
  async insertOne(item, options = {}) {
    const newItem = {
      _id: generateUniqueId(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...item,
    };

    this._data.push(newItem);
    this._index.set(newItem._id, newItem);

    if (options.save) {
      this.database.saveData(this.name);
    }

    return { data: newItem };
  }

  /**
   * Inserts multiple documents into the collection.
   * @param {Array} items - The documents to insert.
   * @param {object} options - The options for the insert operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object} An object containing the inserted documents.
   */
  async insertMany(items, options = {}) {
    const newItems = items.map((item) => ({
      _id: generateUniqueId(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...item,
    }));

    this._data.push(...newItems);

    for (const newItem of newItems) {
      this._index.set(newItem._id, newItem);
    }

    if (options.save) {
      this.database.saveData(this.name);
    }

    return { docs: newItems };
  }

  /**
   * Updates a single document in the collection.
   * @param {object} filter - The filter to find the document to update.
   * @param {object} update - The update to apply to the document.
   * @param {object} options - The options for the update operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object|null} An object containing the updated document, or null if no document was found.
   */
  async updateOne(filter, update, options = {}) {
    // Find the raw document directly (not a projected copy)
    let item = null;
    if (filter._id) {
      item = this._index.get(filter._id) || null;
      if (item && Object.keys(filter).length > 1) {
        item = this.matchesFilter(item, filter) ? item : null;
      }
    } else {
      for (const doc of this._data) {
        if (this.matchesFilter(doc, filter)) {
          item = doc;
          break;
        }
      }
    }

    if (item) {
      this.applyUpdate(item, update);

      if (options.save) {
        this.database.saveData(this.name);
      }

      return { data: item };
    }

    return null;
  }

  /**
   * Updates multiple documents in the collection.
   * @param {object} filter - The filter to find the documents to update.
   * @param {object} update - The update to apply to the documents.
   * @param {object} options - The options for the update operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object|Array} An object containing the updated documents, or an empty array if no documents were found.
   */
  async updateMany(filter, update, options = {}) {
    // Find raw documents directly (not projected copies)
    const items = [];
    for (const doc of this._data) {
      if (this.matchesFilter(doc, filter)) {
        items.push(doc);
      }
    }

    items.forEach((item) => this.applyUpdate(item, update));

    if (options.save) {
      this.database.saveData(this.name);
    }

    return { docs: items };
  }

  /**
   * Applies the update to a document.
   * @param {object} item - The document to update.
   * @param {object} update - The update to apply.
   * @returns {object} The updated document.
   */
  applyUpdate(item, update) {
    for (const field in update) {
      const updateValue = update[field];

      if (typeof updateValue === 'object' && updateValue !== null) {
        for (const key in updateValue) {
          if (key === '$inc' && typeof item[field] === 'number') {
            item[field] += updateValue[key];
          } else if (key === '$push' && Array.isArray(item[field])) {
            item[field].push(updateValue[key]);
          } else if (!key.startsWith('$')) {
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

  /**
   * Finds a single document in the collection.
   * @param {object} filter - The filter to match the document.
   * @param {object} options - The options for the find operation.
   * @param {Array} options.populate - The fields to populate with related data.
   * @param {Array} options.select - The fields to select from the documents.
   * @returns {object|null} The matching document, or null if no document was found.
   */
  async findOne(filter, options = {}) {
    const { populate, select } = options;

    let item = null;

    // Fast path: _id lookup via Map index — O(1)
    if (filter._id) {
      item = this._index.get(filter._id) || null;
      // If filter has additional conditions beyond _id, verify them
      if (item && Object.keys(filter).length > 1) {
        item = this.matchesFilter(item, filter) ? item : null;
      }
    } else {
      // General path: linear scan — O(n)
      for (const doc of this._data) {
        if (this.matchesFilter(doc, filter)) {
          item = doc;
          break;
        }
      }
    }

    if (!item) return null;

    const newItem = {};

    // Populate related data if specified
    if (populate) {
      for (const field of populate) {
        const relatedCollection = this.database.useCollection(field);
        const relatedItem = await relatedCollection.findOne({ _id: item[field] });
        if (relatedItem) newItem[field] = relatedItem;
      }
    }

    // Select specified fields or copy all
    if (select) {
      for (const field of select) newItem[field] = item[field];
    } else {
      Object.assign(newItem, item);
    }

    return newItem;
  }

  /**
   * Finds documents in the collection based on a filter.
   * @param {object} filter - The filter to match the documents.
   * @param {object} options - The options for the find operation.
   * @param {Array} options.populate - The fields to populate with related data.
   * @param {Array} options.select - The fields to select from the documents.
   * @param {object} options.sort - The sorting criteria for the result.
   * @param {number} options.page - The page number for pagination.
   * @param {number} options.limit - The number of documents per page.
   * @returns {object} The matching documents.
   */
  async find(filter, options = {}) {
    const { populate, select, sort, page = 1, limit } = options;

    let results = [];

    for (const item of this._data) {
      if (this.matchesFilter(item, filter)) {
        const newItem = {};

        // Populate related data if specified
        if (populate) {
          for (const field of populate) {
            const relatedCollection = this.database.useCollection(field);
            const relatedItem = await relatedCollection.findOne({
              [field]: item[field],
            });

            if (relatedItem) {
              newItem[field] = relatedItem;
            }
          }
        }

        // Select specified fields
        if (select) {
          for (const field of select) {
            newItem[field] = item[field];
          }
        } else {
          Object.assign(newItem, item);
        }

        results.push(newItem);
      }
    }
    // Apply sorting if sort criteria are specified
    if (sort) {
      const sortFields = Object.keys(sort);

      results.sort((a, b) => {
        for (const field of sortFields) {
          const sortValue = sort[field];
          if (a[field] < b[field]) {
            return sortValue;
          } else if (a[field] > b[field]) {
            return -sortValue;
          }
        }

        return 0;
      });
    }

    // Apply limiting if specified
    if (limit) {
      // Apply pagination if page and limit are specified
      const totalDocs = results.length;
      const totalPages = Math.ceil(totalDocs / limit);
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;

      // Apply pagination to the results
      results = results.slice(startIndex, endIndex);

      return {
        docs: results,
        page,
        totalDocs,
        totalPages,
      };
    } else {
      return { docs: results };
    }
  }

  /**
   * Deletes a single document from the collection.
   * @param {object} filter - The filter to find the document to delete.
   * @param {object} options - The options for the delete operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object|null} An object containing the deleted document, or null if no document was found.
   */
  async deleteOne(filter, options = {}) {
    const index = this.findIndex(filter);

    if (index !== -1) {
      const deletedItem = this._data.splice(index, 1)[0];
      this._index.delete(deletedItem._id);

      if (options.save) {
        this.database.saveData(this.name);
      }

      return { data: deletedItem };
    }

    return null;
  }

  /**
   * Deletes multiple documents from the collection.
   * @param {object} filter - The filter to find the documents to delete.
   * @param {object} options - The options for the delete operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {Array} An array containing the deleted documents.
   */
  async deleteMany(filter, options = {}) {
    const deletedItems = [];
    const remainingItems = [];

    for (const item of this._data) {
      if (this.matchesFilter(item, filter)) {
        deletedItems.push(item);
        this._index.delete(item._id);
      } else {
        remainingItems.push(item);
      }
    }

    this._data = remainingItems;

    if (options.save) {
      this.database.saveData(this.name);
    }

    return { docs: deletedItems };
  }

  /**
   * Checks if a document matches a filter.
   * @param {object} document - The document to check.
   * @param {object} filter - The filter to match.
   * @returns {boolean} Whether the document matches the filter or not.
   */
  matchesFilter(item, filter) {
    // Empty filter matches everything
    if (filter instanceof Object && Object.keys(filter).length === 0) return true;

    // Custom function filter
    if (typeof filter === 'function') return filter(item);

    // All conditions in filter must pass (AND logic)
    for (const key in filter) {
      const keys = key.split('.');
      const nested = keys.length > 1;
      const filterValue = filter[key];

      // Traverse nested path safely
      let itemValue;
      try {
        itemValue = nested
          ? keys.reduce((obj, k) => (obj != null ? obj[k] : undefined), item)
          : item[key];
      } catch {
        return false;
      }

      if (typeof filterValue === 'object' && filterValue !== null && !(filterValue instanceof RegExp)) {
        // Query operators — each must pass
        if ('$eq'    in filterValue && itemValue !== filterValue.$eq)                      return false;
        if ('$ne'    in filterValue && itemValue === filterValue.$ne)                      return false;
        if ('$gt'    in filterValue && !(itemValue > filterValue.$gt))                     return false;
        if ('$lt'    in filterValue && !(itemValue < filterValue.$lt))                     return false;
        if ('$gte'   in filterValue && !(itemValue >= filterValue.$gte))                   return false;
        if ('$lte'   in filterValue && !(itemValue <= filterValue.$lte))                   return false;
        if ('$in'    in filterValue && !filterValue.$in.includes(itemValue))               return false;
        if ('$nin'   in filterValue && filterValue.$nin.includes(itemValue))               return false;
        if ('$regex' in filterValue && !filterValue.$regex.test(String(itemValue)))        return false;
        if ('$fn'    in filterValue && !filterValue.$fn(itemValue))                        return false;
      } else if (filterValue instanceof RegExp) {
        if (!filterValue.test(String(itemValue))) return false;
      } else {
        // Exact match
        if (itemValue !== filterValue) return false;
      }
    }

    return true;
  }

  /**
   * Finds the index of the first document that matches a filter.
   * @param {object} filter - The filter to match.
   * @returns {number} The index of the matching document, or -1 if no document was found.
   */
  findIndex(filter) {
    for (let i = 0; i < this._data.length; i++) {
      const item = this._data[i];
      if (this.matchesFilter(item, filter)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Exports the filtered collection data to a CSV file in the dataDirectory.
   * @param {object} filter - The filter to match the documents to export (default: {}).
   * @param {object} options - The options for the export operation.
   * @param {string} options.dir - The directory path of exports.
   * @param {string} options.name - The export file name.
   * @param {string} options.format - The export file format.
   * @throws {Error} If no matching data is found.
   */
  async export(filter = {}, options = {}) {
    const { dir, name, format = 'json' } = options;

    try {
      const filteredData = this._data.filter(item => this.matchesFilter(item, filter));

      if (filteredData.length === 0) {
        throw new Error(`export(): no documents matched the filter in "${this.name}"`);
      }

      let content;
      if (format === 'json') {
        content = JSON.stringify(filteredData, null, 2);
      } else {
        const header = Object.keys(filteredData[0]).join(',');
        const rows = filteredData.map(item =>
          Object.values(item).map(v =>
            typeof v === 'string' && v.includes(',') ? `"${v}"` : v
          ).join(',')
        );
        content = [header, ...rows].join('\n');
      }

      const exportDir = dir || `${this.database.dataDirectory}/exports`;
      const fileName = `${name || this.name}.${format}`;

      await this.database.fs.checkDir(exportDir);
      await this.database.fs.writeFile(
        this.database.fs.join(exportDir, fileName),
        content,
        'utf8'
      );
    } catch (error) {
      logger(`Error exporting "${this.name}": ${error.message}`, 'error');
      throw error;
    }
  }
}

module.exports = Collection;
