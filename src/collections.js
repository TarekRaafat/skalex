const fs = require("fs");

class Collection {
  constructor(collectionData, database) {
    this.name = collectionData.collectionName;
    this.data = collectionData.data;
    this.index = collectionData.index;
    this.database = database;
  }

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

  findOne(filter) {
    const index = this.findIndex(filter);
    if (index !== -1) {
      for (const item of this.data) {
        if (this.matchesFilter(item, filter)) {
          return item;
        }
      }
    }
    return null;
  }

  find(filter, options = {}) {
    const { populate, select } = options;

    const result = [];

    for (const item of this.data) {
      if (this.matchesFilter(item, filter)) {
        const newItem = {};

        // Populate related data if specified
        if (populate) {
          for (const field of populate) {
            if (this.relations[field]) {
              const relatedCollection = this.database.getCollection(
                this.relations[field].collection
              );
              const relatedItem = relatedCollection.findOne({
                _id: newItem[field],
              });

              if (relatedItem) {
                newItem[field] = relatedItem;
              }
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

        result.push(newItem);
      }
    }

    return result;
  }

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

  matchesFilter(item, filter) {
    for (const key in filter) {
      const filterValue = filter[key];
      const itemValue = item[key];

      if (typeof filterValue === "object") {
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
      } else {
        // Handle exact matching
        if (itemValue !== filterValue) {
          return false;
        }
      }
    }

    return true;
  }

  findIndex(filter) {
    for (let i = 0; i < this.data.length; i++) {
      const item = this.data[i];
      if (this.matchesFilter(item, filter)) {
        return i;
      }
    }
    return -1;
  }

  exportToCSV(filter = {}) {
    const filteredData = this.data.filter((item) =>
      this.matchesFilter(item, filter)
    );

    if (filteredData.length === 0) {
      throw new Error("No matching data found");
    }

    const header = Object.keys(filteredData[0]).join(",");
    const rows = filteredData.map((item) => Object.values(item).join(","));
    const csv = [header, ...rows].join("\n");

    fs.writeFileSync(`./${this.name}.csv`, csv, "utf8");
  }
}

function generateUniqueId() {
  // A simple implementation to generate unique IDs (not guaranteed to be globally unique)
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
}

module.exports = Collection;
