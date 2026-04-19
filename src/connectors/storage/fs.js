import nodePath from "node:path";
import nodeFs from "node:fs";
import zlib from "node:zlib";
import StorageAdapter from "./base.js";

/** Async zlib wrappers - avoids node:util import that breaks browser builds. */
const _deflate = (data) => new Promise((resolve, reject) => zlib.deflate(data, (err, buf) => err ? reject(err) : resolve(buf)));
const _inflate = (data) => new Promise((resolve, reject) => zlib.inflate(data, (err, buf) => err ? reject(err) : resolve(buf)));

/**
 * FsAdapter  -  file-system storage for Node.js, Bun, and Deno.
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
        raw = await _inflate(raw);
      }
      return raw.toString("utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async write(name, data) {
    const fp = this._filePath(name);
    const tmp = nodePath.join(this.dir, `${name}_${globalThis.crypto.randomUUID()}.tmp.${this.format}`);

    if (this.format === "gz") {
      const compressed = await _deflate(data);
      await nodeFs.promises.writeFile(tmp, compressed);
    } else {
      await nodeFs.promises.writeFile(tmp, data, "utf8");
    }
    await nodeFs.promises.rename(tmp, fp);
  }

  /**
   * Batch write: stage all entries to temp files, then rename atomically.
   * If any rename fails, best-effort cleanup of staged temps.
   * @param {{ name: string, data: string }[]} entries
   * @returns {Promise<void>}
   */
  async writeAll(entries) {
    // Stage phase: write all entries to temp files
    const staged = [];
    try {
      for (const { name, data } of entries) {
        const fp = this._filePath(name);
        const tmp = nodePath.join(this.dir, `${name}_${globalThis.crypto.randomUUID()}.tmp.${this.format}`);
        if (this.format === "gz") {
          const compressed = await _deflate(data);
          await nodeFs.promises.writeFile(tmp, compressed);
        } else {
          await nodeFs.promises.writeFile(tmp, data, "utf8");
        }
        staged.push({ tmp, fp });
      }

      // Commit phase: rename all temp files to final paths
      for (const { tmp, fp } of staged) {
        await nodeFs.promises.rename(tmp, fp);
      }
    } catch (error) {
      // Best-effort cleanup of staged temp files
      for (const { tmp } of staged) {
        try { await nodeFs.promises.unlink(tmp); } catch { /* ignore */ }
      }
      throw error;
    }
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

  /**
   * Delete any orphan temp files left by interrupted writes.
   * Temp files are named `<name>_<uuid>.tmp.<format>` - a partial rename on
   * the way out of `write()` / `writeAll()` can leave them on disk.
   * Best-effort: individual unlink failures are ignored.
   * @returns {Promise<number>} The number of temp files removed.
   */
  async cleanOrphans() {
    try {
      const files = await nodeFs.promises.readdir(this.dir);
      const orphans = files.filter(f => f.includes(".tmp."));
      let removed = 0;
      for (const orphan of orphans) {
        const orphanPath = nodePath.join(this.dir, orphan);
        try {
          await nodeFs.promises.unlink(orphanPath);
          removed++;
        } catch { /* ignore cleanup failures */ }
      }
      return removed;
    } catch (err) {
      if (err.code === "ENOENT") return 0;
      throw err;
    }
  }
}

export default FsAdapter;
