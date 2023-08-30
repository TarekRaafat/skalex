const fs = require("fs");
const path = require("path");
const { generateUniqueId, logger } = require("./utils");
const { checkDir } = require("./filesys");

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
    /**
     * The name of the collection.
     * @type {string}
     */
    this.name = collectionData.collectionName;
    /**
     * The data stored in the collection.
     * @type {Array}
     */
    this.data = collectionData.data;
    /**
     * The index map for quick document lookup.
     * @type {Map}
     */
    this.index = collectionData.index;
    /**
     * The Skalex database instance.
     * @type {Skalex}
     */
    this.database = database;
  }

  /**
   * Inserts a single document into the collection.
   * @param {object} item - The document to insert.
   * @param {object} options - The options for the find operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object} An object containing the inserted document.
   */
  async insertOne(item, options = {}) {
    const newItem = {
      _id: generateUniqueId(),
      createdAt: new Date(),
      ...item,
    };

    this.data.push(newItem);
    this.index.set(newItem._id, newItem);

    if (options.save) {
      this.database.saveData(this.name);
    }

    return newItem;
  }

  /**
   * Inserts multiple documents into the collection.
   * @param {Array} items - The documents to insert.
   * @param {object} options - The options for the find operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object} An object containing the inserted documents.
   */
  async insertMany(items, options = {}) {
    const newItems = items.map((item) => ({
      _id: generateUniqueId(),
      createdAt: new Date(),
      ...item,
    }));

    this.data.push(...newItems);

    for (const newItem of newItems) {
      this.index.set(newItem._id, newItem);
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
   * @param {object} options - The options for the find operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object|null} An object containing the updated document, or null if no document was found.
   */
  async updateOne(filter, update, options = {}) {
    const item = await this.findOne(filter);

    if (item) {
      this.applyUpdate(item, update);

      if (options.save) {
        this.database.saveData(this.name);
      }

      return item;
    }

    return null;
  }

  /**
   * Updates multiple documents in the collection.
   * @param {object} filter - The filter to find the documents to update.
   * @param {object} update - The update to apply to the documents.
   * @param {object} options - The options for the find operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object|Array} An object containing the updated documents, or an empty array if no documents were found.
   */
  async updateMany(filter, update, options = {}) {
    const { docs: items } = await this.find(filter);

    if (items.length > 0) {
      items.forEach((item) => this.applyUpdate(item, update));

      if (options.save) {
        this.database.saveData(this.name);
      }

      return { docs: items };
    }

    return [];
  }

  /**
   * Applies the update to a document.
   * @param {object} item - The document to update.
   * @param {object} update - The update to apply.
   * @returns {object} The updated document.
   */
  applyUpdate(item, update) {
    // Update fields based on the update object
    for (const field in update) {
      const updateValue = update[field];
      let itemValue = item[field];

      if (typeof updateValue === "object") {
        for (const key in updateValue) {
          if (key.startsWith("$")) {
            // Handle $inc operator (Increment field value)
            if (key === "$inc" && typeof itemValue === "number") {
              itemValue += updateValue[key];
            }
            // Handle $push operator (Add element to an array)
            if (key === "$push" && Array.isArray(itemValue)) {
              itemValue.push(updateValue[key]);
            }
          } else {
            // For other fields, update the value
            item[field] = updateValue;
          }
        }
      } else {
        item[field] = updateValue;
      }

      // Update the "updatedAt" field
      item.updatedAt = new Date();

      // Update the "collection" data
      Object.assign(item, item);
      // Update the "index" data
      this.index.set(item._id, item);
    }

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

    const index = this.findIndex(filter);
    if (index !== -1) {
      for (const item of this.data) {
        if (this.matchesFilter(item, filter)) {
          const newItem = {};

          // Populate related data if specified
          if (populate) {
            for (const field of populate) {
              const relatedCollection = this.database.useCollection(field);
              const relatedItem = await relatedCollection.findOne({
                _id: item[field],
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

          return item;
        }
      }
    }

    return null;
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

    for (const item of this.data) {
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
   * @param {object} options - The options for the find operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {object|null} An object containing the deleted document, or null if no document was found.
   */
  async deleteOne(filter, options = {}) {
    const index = this.findIndex(filter);

    if (index !== -1) {
      const deletedItem = this.data.splice(index, 1)[0];
      this.index.delete(deletedItem._id);

      if (options.save) {
        this.database.saveData(this.name);
      }

      return deletedItem;
    }

    return null;
  }

  /**
   * Deletes multiple documents from the collection.
   * @param {object} filter - The filter to find the documents to delete.
   * @param {object} options - The options for the find operation.
   * @param {boolean} options.save - The save criteria for the operation.
   * @returns {Array} An array containing the deleted documents.
   */
  async deleteMany(filter, options = {}) {
    const deletedItems = [];
    const remainingItems = [];

    for (const item of this.data) {
      if (this.matchesFilter(item, filter)) {
        deletedItems.push(item);
        this.index.delete(item._id);
      } else {
        remainingItems.push(item);
      }
    }

    this.data = remainingItems;

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
    // Handle empty filter
    if (!filter) return true;

    // Handle custom function
    if (typeof filter === "function" && filter(item)) return true;

    // Handle filters
    for (const key in filter) {
      const keys = key.split("."); // Split nested keys
      const nested = keys.length > 1;

      const filterValue = filter[key];
      let itemValue = nested ? item : item[key];

      if (nested) {
        for (const nestedKey of keys) {
          if (itemValue[nestedKey]) {
            itemValue = itemValue[nestedKey];
          }
        }
      }

      if (typeof filterValue === "object" && itemValue) {
        // Handle query operators
        if ("$eq" in filterValue && itemValue === filterValue.$eq) {
          return true;
        }
        if ("$ne" in filterValue && itemValue !== filterValue.$ne) {
          return true;
        }
        if ("$gt" in filterValue && itemValue > filterValue.$gt) {
          return true;
        }
        if ("$lt" in filterValue && itemValue < filterValue.$lt) {
          return true;
        }
        if ("$gte" in filterValue && itemValue >= filterValue.$gte) {
          return true;
        }
        if ("$lte" in filterValue && itemValue <= filterValue.$lte) {
          return true;
        }
        if ("$in" in filterValue && itemValue.includes(filterValue.$in)) {
          return true;
        }
        if ("$nin" in filterValue && !itemValue.includes(filterValue.$nin)) {
          return true;
        }
        if ("$regex" in filterValue && filterValue.$regex.test(itemValue)) {
          return true;
        }
        if ("$fn" in filterValue) {
          return filterValue.$fn(itemValue);
        }
      } else {
        // Handle exact matching
        return itemValue === filterValue;
      }
    }

    return false;
  }

  /**
   * Finds the index of the first document that matches a filter.
   * @param {object} filter - The filter to match.
   * @returns {number} The index of the matching document, or -1 if no document was found.
   */
  findIndex(filter) {
    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i];
      if (this.matchesFilter(item, filter)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Exports the filtered collection data to a CSV file in the dataDirectory.
   * @param {object} filter - The filter to match the documents to export (default: {}).
   * @param {object} options - The options for the find operation.
   * @param {string} options.dir - The directory path of exports.
   * @param {string} options.name - The export file name.
   * @param {string} options.format - The export file format.
   * @throws {Error} If no matching data is found.
   */
  async export(filter = {}, options = {}) {
    const { dir, name, format = "json" } = options;

    const dirPath = path.resolve(
      dir || `${this.database.dataDirectory}/exports`
    );
    const filePath = path.join(dirPath, `${name || this.name}.${format}`);

    try {
      checkDir(dirPath);

      const filteredData = this.data.filter((item) =>
        this.matchesFilter(item, filter)
      );

      if (filteredData.length === 0) {
        throw new Error("No matching data found");
      }

      let data;
      if (format === "json") {
        data = filteredData;
      } else {
        const header = Object.keys(filteredData[0]).join(",");
        const rows = filteredData.map((item) => Object.values(item).join(","));
        data = [header, ...rows].join("\n");
      }

      fs.writeFileSync(filePath, data, "utf8");
    } catch (error) {
      logger(`Error exporting "${this.name}" collection: ${error}`, "error");
    }
  }
}

module.exports = Collection;
