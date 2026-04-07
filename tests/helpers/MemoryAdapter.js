import StorageAdapter from "../../src/connectors/storage/base.js";

/**
 * MemoryAdapter  -  in-memory StorageAdapter for testing.
 * Extends StorageAdapter so instanceof checks and inherited methods work.
 */
class MemoryAdapter extends StorageAdapter {
  constructor() {
    super();
    this._store = new Map();
    // Expose join/ensureDir/writeRaw stubs for export() compatibility
    this.dir = "/memory";
  }

  async read(name) {
    return this._store.get(name) ?? null;
  }

  async write(name, data) {
    this._store.set(name, typeof data === "string" ? data : JSON.stringify(data));
  }

  async writeAll(entries) {
    for (const { name, data } of entries) await this.write(name, data);
  }

  async delete(name) {
    this._store.delete(name);
  }

  async list() {
    return [...this._store.keys()];
  }

  // Utility stubs used by Collection.export()
  join(...parts) {
    return parts.join("/");
  }

  ensureDir() {}

  async writeRaw(filePath, content) {
    this._store.set(`__raw:${filePath}`, content);
  }

  async readRaw(filePath) {
    const val = this._store.get(`__raw:${filePath}`);
    if (val == null) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    return val;
  }

  /** Helpers for test assertions */
  getRaw(filePath) {
    return this._store.get(`__raw:${filePath}`) ?? null;
  }

  /** Reset all stored data  -  useful for cleaning up between test cases. */
  clear() {
    this._store.clear();
  }
}

export default MemoryAdapter;
