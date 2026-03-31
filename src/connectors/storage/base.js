/**
 * StorageAdapter — interface all storage backends must implement.
 *
 * All methods are async. `name` is a collection identifier string
 * (no path separators — the adapter maps it to its own storage scheme).
 */
class StorageAdapter {
  /**
   * Read a collection file. Returns the raw string content, or null if not found.
   * @param {string} name
   * @returns {Promise<string|null>}
   */
  async read(name) {
    throw new Error("StorageAdapter.read() not implemented");
  }

  /**
   * Write a collection. `data` is the serialised string to persist.
   * @param {string} name
   * @param {string} data
   * @returns {Promise<void>}
   */
  async write(name, data) {
    throw new Error("StorageAdapter.write() not implemented");
  }

  /**
   * Delete a collection.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async delete(name) {
    throw new Error("StorageAdapter.delete() not implemented");
  }

  /**
   * List all stored collection names.
   * @returns {Promise<string[]>}
   */
  async list() {
    throw new Error("StorageAdapter.list() not implemented");
  }
}

export default StorageAdapter;
