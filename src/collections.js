const fs = require("fs");
const { generateUniqueId } = require("./utils");

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
   * @returns {object} An object containing the inserted document and a save function to save the data.
   */
  insertOne(item) {
    const newItem = {
      _id: generateUniqueId(),
      ...item,
      createdAt: new Date(),
    };
    this.data.push(newItem);
    this.index.set(newItem._id, newItem);
    return {
      data: newItem,
      save: () => this.database.saveData(newItem),
    };
  }

  /**
   * Inserts multiple documents into the collection.
   * @param {Array} items - The documents to insert.
   * @returns {object} An object containing the inserted documents and a save function to save the data.
   */
  insertMany(items) {
    const newItems = items.map((item) => ({
      _id: generateUniqueId(),
      ...item,
      createdAt: new Date(),
    }));
    this.data.push(...newItems);
    for (const newItem of newItems) {
      this.index.set(newItem._id, newItem);
    }
    return {
      data: newItems,
      save: () => this.database.saveData(newItems),
    };
  }

  /**
   * Updates a single document in the collection.
   * @param {object} filter - The filter to find the document to update.
   * @param {object} update - The update to apply to the document.
   * @returns {object|null} An object containing the updated document and a save function to save the data, or null if no document was found.
   */
  updateOne(filter, update) {
    const item = this.findOne(filter);
    if (item) {
      Object.assign(item, { ...update, updatedAt: new Date() });
      return {
        data: item,
        save: () => this.database.saveData(item),
      };
    }
    return null;
  }

  /**
   * Updates multiple documents in the collection.
   * @param {object} filter - The filter to find the documents to update.
   * @param {object} update - The update to apply to the documents.
   * @returns {object|Array} An object containing the updated documents and a save function to save the data, or an empty array if no documents were found.
   */
  updateMany(filter, update) {
    const items = this.find(filter);
    if (items.length > 0) {
      for (const item of items) {
        Object.assign(item, { ...update, updatedAt: new Date() });
      }
      return {
        data: items,
        save: () => this.database.saveData(items),
      };
    }
    return [];
  }

  /**
   * Finds a single document in the collection.
   * @param {object} filter - The filter to match the document.
   * @param {object} options - The options for the find operation.
   * @param {Array} options.populate - The fields to populate with related data.
   * @param {Array} options.select - The fields to select from the documents.
   * @returns {object|null} The matching document, or null if no document was found.
   */
  findOne(filter, options = {}) {
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
              const relatedItem = relatedCollection.findOne({
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
   * @returns {Array} The matching documents.
   */
  find(filter, options = {}) {
    const { populate, select, sort, page = 1, limit = 10 } = options;

    let results = [];

    for (const item of this.data) {
      if (this.matchesFilter(item, filter)) {
        const newItem = {};

        // Populate related data if specified
        if (populate) {
          for (const field of populate) {
            const relatedCollection = this.database.useCollection(field);
            const relatedItem = relatedCollection.findOne({
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

    // Apply pagination if page and limit are specified
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    results = results.slice(startIndex, endIndex);

    return results;
  }

  /**
   * Deletes a single document from the collection.
   * @param {object} filter - The filter to find the document to delete.
   * @returns {object|null} An object containing the deleted document and a save function to save the data, or null if no document was found.
   */
  deleteOne(filter) {
    const index = this.findIndex(filter);
    if (index !== -1) {
      const deletedItem = this.data.splice(index, 1)[0];
      this.index.delete(deletedItem._id);
      return {
        data: deletedItem,
        save: () => this.database.saveData(),
      };
    }
    return null;
  }

  /**
   * Deletes multiple documents from the collection.
   * @param {object} filter - The filter to find the documents to delete.
   * @returns {Array} An array containing the deleted documents and a save function to save the data.
   */
  deleteMany(filter) {
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
    return {
      data: deletedItems,
      save: () => this.database.saveData(),
    };
  }

  /**
   * Checks if a document matches a filter.
   * @param {object} document - The document to check.
   * @param {object} filter - The filter to match.
   * @returns {boolean} Whether the document matches the filter or not.
   */
  matchesFilter(item, filter) {
    // Handle custom function
    if (typeof filter === "function" && !filter(item)) return false;

    for (const key in filter) {
      const filterValue = filter[key];
      const itemValue = item[key];

      if (typeof filterValue === "object" && itemValue) {
        // Handle query operators
        if ("$eq" in filterValue && itemValue !== filterValue.$eq) {
          return false;
        }
        if ("$ne" in filterValue && itemValue === filterValue.$ne) {
          return false;
        }
        if ("$gt" in filterValue && itemValue <= filterValue.$gt) {
          return false;
        }
        if ("$lt" in filterValue && itemValue >= filterValue.$lt) {
          return false;
        }
        if ("$gte" in filterValue && itemValue < filterValue.$gte) {
          return false;
        }
        if ("$lte" in filterValue && itemValue > filterValue.$lte) {
          return false;
        }
        if ("$in" in filterValue && !itemValue.includes(filterValue.$in)) {
          return false;
        }
        if ("$nin" in filterValue && itemValue.includes(filterValue.$nin)) {
          return false;
        }
        if ("$regex" in filterValue && !filterValue.$regex.test(itemValue)) {
          return false;
        }
        if ("$fn" in filterValue && !filterValue.$fn(itemValue)) {
          return false;
        }
      } else {
        // Handle exact matching
        if (itemValue !== filterValue) {
          return false;
        }
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
    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i];
      if (this.matchesFilter(item, filter)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Exports the filtered collection data to a CSV file in the root directory.
   * @param {object} filter - The filter to match the documents to export (default: {}).
   * @throws {Error} If no matching data is found.
   */
  exportToCSV(filter = {}) {
    const filteredData = this.data.filter((item) =>
      this.matchesFilter(item, filter)
    );

    if (filteredData.length === 0) {
      console.error("No matching data found");
    }

    const header = Object.keys(filteredData[0]).join(",");
    const rows = filteredData.map((item) => Object.values(item).join(","));
    const csv = [header, ...rows].join("\n");

    fs.writeFileSync(`./${this.name}.csv`, csv, "utf8");
  }
}

module.exports = Collection;
