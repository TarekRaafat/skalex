import StorageAdapter from "../../src/connectors/storage/base.js";

/**
 * MemoryAdapter  -  in-memory StorageAdapter for testing.
 * Extends StorageAdapter so instanceof checks and inherited methods work.
 */
class MemoryAdapter extends StorageAdapter {
  /**
   * @param {object} [opts]
   * @param {boolean|((name: string) => boolean)} [opts.throwOnWrite] - fail every write, or per-name.
   * @param {boolean|((name: string) => boolean)} [opts.throwOnRead]  - fail every read, or per-name.
   * @param {boolean} [opts.throwOnWriteAll] - fail batch writes.
   */
  constructor({ throwOnWrite = false, throwOnRead = false, throwOnWriteAll = false } = {}) {
    super();
    this._store = new Map();
    // Expose join/ensureDir/writeRaw stubs for export() compatibility
    this.dir = "/memory";
    this.throwOnWrite    = throwOnWrite;
    this.throwOnRead     = throwOnRead;
    this.throwOnWriteAll = throwOnWriteAll;
  }

  _shouldFail(flag, name) {
    if (typeof flag === "function") return flag(name);
    return Boolean(flag);
  }

  async read(name) {
    if (this._shouldFail(this.throwOnRead, name)) {
      throw new Error(`MemoryAdapter: injected read failure for "${name}"`);
    }
    return this._store.get(name) ?? null;
  }

  async write(name, data) {
    if (this._shouldFail(this.throwOnWrite, name)) {
      throw new Error(`MemoryAdapter: injected write failure for "${name}"`);
    }
    this._store.set(name, typeof data === "string" ? data : JSON.stringify(data));
  }

  async writeAll(entries) {
    if (this.throwOnWriteAll) {
      throw new Error("MemoryAdapter: injected writeAll failure");
    }
    // Delegate to write() so test overrides on `adapter.write` are observed
    // by both single-write and batch-write code paths.
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
