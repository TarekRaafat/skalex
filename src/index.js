const fs = require("fs");
const Collection = require("./Collections");
const { logger } = require("./utils");

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

      logger(`> - Connected to the database (√)`);
    } catch (error) {
      logger(`Error connecting to the database: ${error}`, "error");

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

      logger(`> - Disconnected from the database (√)`);
    } catch (error) {
      logger(`Error disconnecting from the database: ${error}`, "error");

      throw error;
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
      logger(`Error loading data: ${error}`, "error");

      throw error;
    }
  }

  /**
   * Saves data to JSON files in the data directory.
   * @param {any} [output] - Output data.
   * @returns {Promise<any>} The output data.
   */
  async saveData(output) {
    if (!this.isSaving) {
      this.isSaving = true;

      try {
        await fs.promises.mkdir(this.dataDirectory, { recursive: true });

        for (const collectionName in this.collections) {
          const collectionData = this.collections[collectionName];
          const jsonData = JSON.stringify({
            collectionName,
            data: collectionData.data,
          });

          const tempFileName = `${collectionName}_${Date.now()}_${Math.random()
            .toString(36)
            .substring(6)}.tmp`;
          const tempFilePath = `${this.dataDirectory}/${tempFileName}`;

          await fs.promises.writeFile(tempFilePath, jsonData, "utf8");

          await fs.promises.rename(
            tempFilePath,
            `${this.dataDirectory}/${collectionName}.json`
          );
        }

        this.isSaving = false;

        return output;
      } catch (error) {
        logger(`Error saving data: ${error}`, "error");

        throw error;
      }
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
