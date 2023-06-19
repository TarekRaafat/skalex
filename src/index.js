const fs = require("fs");
const Collection = require("./Collections");

/**
 * Skalex is a simple JavaScript code library for managing a database with collections.
 * @class
 */
class Skalex {
  /**
   * Creates an instance of Skalex.
   * @param {string} dataDirectory - The directory where data files will be stored.
   */
  constructor(dataDirectory) {
    /**
     * The directory where data files are stored.
     * @type {string}
     */
    this.dataDirectory = dataDirectory;
    /**
     * The collections in the database.
     * @type {object}
     */
    this.collections = {};
    /**
     * Indicates whether the database is connected or not.
     * @type {boolean}
     */
    this.isConnected = false;
    /**
     * Flag to prevent multiple save operations from overlapping.
     * @type {boolean}
     */
    this.isSaving = false;

    // Create the data directory if it does not exist
    if (!fs.existsSync(dataDirectory)) {
      fs.mkdirSync(dataDirectory, { recursive: true });
    }
  }

  /**
   * Connects to the database and loads existing data.
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      // Load existing data
      await this.loadData();
      this.isConnected = true;
      console.log(`> - Connected to the database (√)`);
    } catch (error) {
      console.error("Error connecting to the database: ", error);
      throw error;
    }
  }

  /**
   * Disconnects from the database and saves data.
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      // Save data before disconnecting
      await this.saveData();
      this.collections = {};
      this.isConnected = false;
      console.log(`> - Disconnected from the database (√)`);
    } catch (error) {
      console.error("Error disconnecting from the database: ", error);
    }
  }

  /**
   * Retrieves an existing collection or creates a new one.
   * @param {string} collectionName - The name of the collection.
   * @returns {Collection} The collection object.
   */
  useCollection(collectionName) {
    if (this.collections[collectionName]) {
      // Collection already exists, return it
      return new Collection(this.collections[collectionName], this);
    }

    // Create a new collection and return it
    return this.createCollection(collectionName);
  }

  /**
   * Creates a new collection.
   * @param {string} collectionName - The name of the collection.
   * @returns {Collection} The new collection object.
   */
  createCollection(collectionName) {
    this.collections[collectionName] = {
      collectionName,
      data: [],
      index: new Map(),
    };

    return new Collection(this.collections[collectionName], this);
  }

  /**
   * Loads data from JSON files in the data directory.
   * @returns {Promise<void>}
   */
  async loadData() {
    try {
      const filenames = await fs.promises.readdir(this.dataDirectory);

      for (const filename of filenames) {
        const collectionData = await fs.promises.readFile(
          `${this.dataDirectory}/${filename}`,
          "utf8"
        );
        const { collectionName, data } = JSON.parse(collectionData);
        this.collections[collectionName] = {
          collectionName,
          data,
          index: this.buildIndex(data, "_id"),
        };
      }
    } catch (error) {
      console.error("Error loading data: ", error);
      throw error;
    }
  }

  /**
   * Saves data to JSON files in the data directory.
   * @returns {Promise<void>}
   */
  async saveData() {
    try {
      this.isSaving = true;

      await fs.promises.mkdir(this.dataDirectory, { recursive: true });

      for (const collectionName in this.collections) {
        const collectionData = this.collections[collectionName];
        const jsonData = JSON.stringify({
          collectionName,
          data: collectionData.data,
        });

        await fs.promises.writeFile(
          `${this.dataDirectory}/${collectionName}.json`,
          jsonData,
          "utf8"
        );
      }

      this.isSaving = false;
    } catch (error) {
      console.error("Error saving data: ", error);
      throw error;
    }
  }

  /**
   * Builds an index for quick document lookup.
   * @param {Array} data - The data to build the index from.
   * @param {string} keyField - The field to use as the index key.
   * @returns {Map} The index map.
   */
  buildIndex(data, keyField) {
    const index = new Map();

    for (const item of data) {
      const itemId = item[keyField];
      index.set(itemId, item);
    }

    return index;
  }
}

module.exports = Skalex;
