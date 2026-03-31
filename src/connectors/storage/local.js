import StorageAdapter from "./base.js";

/**
 * LocalStorageAdapter — browser localStorage backend.
 *
 * Keys are prefixed with `skalex:<namespace>:<name>` to avoid collisions.
 * Data is stored as plain JSON strings (no compression in localStorage).
 */
class LocalStorageAdapter extends StorageAdapter {
  /**
   * @param {object} opts
   * @param {string} [opts.namespace="default"] - Key namespace prefix
   */
  constructor({ namespace = "default" } = {}) {
    super();
    this._prefix = `skalex:${namespace}:`;
    if (typeof localStorage === "undefined") {
      throw new Error("LocalStorageAdapter requires a browser environment with localStorage");
    }
  }

  _key(name) {
    return `${this._prefix}${name}`;
  }

  async read(name) {
    const val = localStorage.getItem(this._key(name));
    return val === null ? null : val;
  }

  async write(name, data) {
    localStorage.setItem(this._key(name), data);
  }

  async delete(name) {
    localStorage.removeItem(this._key(name));
  }

  async list() {
    return Object.keys(localStorage)
      .filter(key => key.startsWith(this._prefix))
      .map(key => key.slice(this._prefix.length));
  }
}

export default LocalStorageAdapter;
