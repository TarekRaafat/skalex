import { PersistenceError } from "./errors.js";

/**
 * SkalexImporter - handles JSON file import into collections.
 *
 * Extracted from Skalex to remove filesystem-specific logic from the
 * main class.
 *
 * @param {object} opts
 * @param {object} opts.fs - Storage adapter with readRaw().
 * @param {Function} opts.getCollection - (name) => Collection instance.
 */
class SkalexImporter {
  constructor({ fs, getCollection }) {
    this._fs = fs;
    this._getCollection = getCollection;
  }

  /**
   * Import documents from a JSON file into a collection.
   * The collection name is derived from the file name (without extension).
   * @param {string} filePath - Absolute or relative path to the file.
   * @returns {Promise<Document[]>}
   */
  async import(filePath) {
    const content = await this._fs.readRaw(filePath);
    let docs;
    try {
      docs = JSON.parse(content);
    } catch {
      throw new PersistenceError("ERR_SKALEX_PERSISTENCE_INVALID_JSON", `import: invalid JSON in file "${filePath}"`, { filePath });
    }
    const name = filePath.split("/").pop().replace(/\.[^.]+$/, "");
    const col = this._getCollection(name);
    return col.insertMany(Array.isArray(docs) ? docs : [docs], { save: true });
  }
}

export default SkalexImporter;
