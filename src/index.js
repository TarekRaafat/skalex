const Collection = require("./collection");
const { logger } = require("./utils");
const fs = require("./filesys");

/**
 * Skalex is a simple JavaScript code library for managing a database with collections.
 * @class
 */
class Skalex {
  /**
   * Creates an instance of Skalex.
   * @param {object} config - The database configurations.
   * @param {string} config.path - The directory path of the database.
   * @param {string} config.format - The database files format.
   *
   */
  constructor({ path = "./.db", format = "gz" }) {
    this.fs = new fs({ path });
    /**
     * The directory where data files are stored.
     * @type {string}
     */
    this.dataDirectory = this.fs.dir;
    /**
     * The format in which the data files will be stored in the database.
     * @type {string}
     */
    this.dataFormat = format;
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
      const filenames = await this.fs.readDir(this.dataDirectory);

      const loadCollection = filenames.map(async (filename) => {
        const filePath = this.fs.join(this.dataDirectory, filename);

        try {
          const docCheck = await this.fs.getStat(filePath);

          if (docCheck.isFile()) {
            const collectionData = await this.fs.readFile(
              filePath,
              this.dataFormat
            );

            const { collectionName, data } = JSON.parse(collectionData);

            this.collections[collectionName] = {
              collectionName,
              data,
              index: this.buildIndex(data, "_id"),
            };
          }
        } catch (error) {
          logger(`Error reading files: ${error}`, "error");
        }
      });

      await Promise.all(loadCollection);
    } catch (error) {
      logger(`Error loading data: ${error}`, "error");

      throw error;
    }
  }

  /**
   * Saves data to JSON files in the data directory.
   * @param {string} collectionName - The name of the collection to be saved.
   * @returns {Promise<void>}
   */
  async saveData(collectionName) {
    // If saving is already in progress, skip
    if (!this.isSaving) {
      this.isSaving = true;

      try {
        const promises = [];

        const saveCollection = async (collectionName) => {
          const collectionData = this.collections[collectionName];
          const jsonData = JSON.stringify({
            collectionName,
            data: collectionData.data,
          });

          const tempFileName = `${collectionName}_${Date.now()}.tmp.${
            this.dataFormat
          }`;
          const tempFilePath = this.fs.join(this.dataDirectory, tempFileName);
          const finalFilePath = this.fs.join(
            this.dataDirectory,
            `${collectionName}.${this.dataFormat}`
          );

          await this.fs.writeFile(tempFilePath, jsonData, this.dataFormat);
          await this.fs.renameFile(tempFilePath, finalFilePath);
        };

        if (!collectionName) {
          for (const collectionName in this.collections) {
            promises.push(saveCollection(collectionName));
          }
        } else {
          promises.push(saveCollection(collectionName));
        }

        await Promise.all(promises);

        this.isSaving = false;
      } catch (error) {
        this.isSaving = false;

        logger(`Error saving data: ${error}`, "error");
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
