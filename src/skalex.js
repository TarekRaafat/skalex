const fs = require("fs");
const Collection = require("./collections");

class Skalex {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.collections = {};
    this.isConnected = false;

    // Create the data directory if it does not exist
    if (!fs.existsSync(dataDirectory)) {
      fs.mkdirSync(dataDirectory, { recursive: true });
    }
  }

  async connect() {
    try {
      await this.loadData();
      this.isConnected = true;
      console.log(`> - Connected to the database (√)`);
    } catch (error) {
      console.error("Error connecting to the database:", error);
      throw error;
    }
  }

  async disconnect() {
    try {
      await this.saveData();
      this.collections = {};
      this.isConnected = false;
      console.log(`> - Disconnected from the database (√)`);
    } catch (error) {
      console.error("Error disconnecting from the database:", error);
    }
  }

  useCollection(collectionName) {
    if (this.collections[collectionName]) {
      return new Collection(this.collections[collectionName], this);
    }

    return this.createCollection(collectionName);
  }

  createCollection(collectionName) {
    this.collections[collectionName] = {
      collectionName,
      data: [],
      index: new Map(),
    };

    return new Collection(this.collections[collectionName], this);
  }

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
          index: this.buildIndex(data),
        };
      }
    } catch (error) {
      console.error("Error loading data:", error);
      throw error;
    }
  }

  async saveData(output) {
    try {
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

      return output;
    } catch (error) {
      console.error("Error saving data:", error);
      throw error;
    }
  }

  buildIndex(data) {
    const index = new Map();

    for (const item of data) {
      const itemId = item._id;
      index.set(itemId, item);
    }

    return index;
  }
}

module.exports = Skalex;
