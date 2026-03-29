const nodePath = require("path");
const nodeFs = require("fs");
const zlib = require("zlib");
const StorageAdapter = require("./base");

/**
 * FsAdapter — file-system storage for Node.js, Bun, and Deno.
 *
 * Files are stored as `<dir>/<name>.<format>`.
 * format="gz"  → zlib deflate compressed JSON
 * format="json" → plain JSON
 */
class FsAdapter extends StorageAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.dir   - Resolved directory path
   * @param {string} [opts.format="gz"] - "gz" or "json"
   */
  constructor({ dir, format = "gz" }) {
    super();
    this.dir = nodePath.resolve(dir);
    this.format = format;
    this._ensureDir(this.dir);
  }

  _ensureDir(dir) {
    if (!nodeFs.existsSync(dir)) {
      nodeFs.mkdirSync(dir, { recursive: true });
    }
  }

  _filePath(name) {
    return nodePath.join(this.dir, `${name}.${this.format}`);
  }

  async read(name) {
    const fp = this._filePath(name);
    try {
      let raw = await nodeFs.promises.readFile(fp);
      if (this.format === "gz") {
        raw = zlib.inflateSync(raw);
      }
      return raw.toString("utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async write(name, data) {
    this._ensureDir(this.dir);
    const fp = this._filePath(name);
    const tmp = nodePath.join(this.dir, `${name}_${Date.now()}.tmp.${this.format}`);

    let output = data;
    let encoding = "utf8";

    if (this.format === "gz") {
      output = zlib.deflateSync(data);
      encoding = "binary";
    }

    await nodeFs.promises.writeFile(tmp, output, encoding);
    await nodeFs.promises.rename(tmp, fp);
  }

  async delete(name) {
    const fp = this._filePath(name);
    try {
      await nodeFs.promises.unlink(fp);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async list() {
    try {
      const files = await nodeFs.promises.readdir(this.dir);
      const ext = `.${this.format}`;
      return files
        .filter(f => f.endsWith(ext) && !f.includes(".tmp."))
        .map(f => f.slice(0, -ext.length));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  /** Utility: resolve a path relative to the data dir. */
  resolve(p) {
    return nodePath.resolve(p);
  }

  /** Utility: join paths. */
  join(...parts) {
    return nodePath.join(...parts);
  }

  /** Utility: ensure a directory exists (used by export). */
  ensureDir(dir) {
    this._ensureDir(dir);
  }

  /** Write arbitrary content to any path (used by export). */
  async writeRaw(filePath, content) {
    this._ensureDir(nodePath.dirname(filePath));
    await nodeFs.promises.writeFile(filePath, content, "utf8");
  }

  /** Read arbitrary content from any path (used by import). */
  async readRaw(filePath) {
    return nodeFs.promises.readFile(nodePath.resolve(filePath), "utf8");
  }
}

module.exports = FsAdapter;
