const p = require("path");
const f = require("fs");
const zlib = require("zlib");

class fs {
  constructor({ path }) {
    this.dir = p.resolve(path);

    // Ensure the data directory exists or create it if it does not exist
    this.checkDir(this.dir);
  }

  /**
   * Takes a path as input and returns the resolved path.
   * @param path - String representing a file or directory path.
   * @returns the resolved path.
   */
  resolve(path) {
    return p.resolve(path);
  }

  /**
   * Takes two paths as input and returns the joined path.
   * @param path1 - String representing the first part of the path.
   * @param path2 - String representing the second part of a file or directory
   * path.
   * @returns the result of joining `path1` and `path2`.
   */
  join(path1, path2) {
    return p.join(path1, path2);
  }

  /**
   * Checks if a directory exists, and if not, creates it.
   * @param directoryPath - String that represents the path of the directory
   */
  checkDir(directoryPath) {
    if (!f.existsSync(directoryPath)) {
      f.mkdirSync(directoryPath, { recursive: true });
    }
  }

  /**
   * Reads the contents of a directory asynchronously.
   * @param dirPath - String that represents the path to a directory.
   * @returns A promise that resolves to an array of filenames in the specified `dirPath`.
   */
  async readDir(dirPath) {
    return await f.promises.readdir(dirPath);
  }

  /**
   * Reads a file asynchronously and returns its contents as a string,
   * optionally decompressing the data if the file format is "gz".
   * @param filePath - String that specifies the path to the file to read.
   * It can be either a relative or an absolute path.
   * @param fileFormat - String that represents the format of the file.
   * It is used to determine if the file needs to be decompressed before reading its contents.
   * @returns The contents of the file as a string in UTF-8 encoding.
   */
  async readFile(filePath, fileFormat) {
    let data = await f.promises.readFile(filePath);

    if (fileFormat === "gz") {
      data = this.decompressData(data, fileFormat);
    }

    return data.toString("utf8");
  }

  /**
   * Retrieves the file statistics of a given file path asynchronously.
   * @param filePath - String that represents the path to a file on the file system.
   * @returns A promise that resolves to an object of information about the file or directory.
   */
  async getStat(path) {
    return await f.promises.stat(path);
  }

  /**
   * Writes data to a file, compressing it if the file format is "gz".
   * @param filePath - String that specifies the path to the file to write the data.
   * It can be an absolute or relative path.
   * @param data - The content to write to the file. It can be a
   * string, a buffer, or an object that will be serialized to JSON.
   * @param fileFormat - String that represents the format of the file to
   * be written. It can have two possible values: "gz" or any other value. If the `fileFormat` is "gz",
   * the file will be compressed before writing it.
   * @returns A promise that resolves to undefined.
   */
  async writeFile(filePath, data, fileFormat) {
    data = JSON.stringify(data);
    const fileEncoding = fileFormat === "gz" ? "binary" : "utf8";

    if (fileEncoding === "binary") {
      data = this.compressData(data);
    }

    return await f.promises.writeFile(filePath, data, fileEncoding);
  }

  /**
   * Renames a file asynchronously.
   * @param oldName - String that represents the old name of the file that will be renamed.
   * @param newName - String that represents the new name or path of the file.
   * @returns A promise that resolves to the result of renaming the file.
   */
  async renameFile(oldName, newName) {
    return await f.promises.rename(oldName, newName);
  }

  /**
   * Compresses data using the zlib library.
   * @param data - The input data that to compress.
   * It can be any type of data, such as a string, an array, or an object.
   * @returns The compressed data.
   */

  compressData(data) {
    return zlib.deflateSync(data);
  }

  /**
   * Decompresses compressed data.
   * @param compressedData - The compressed data.
   * @returns the decompressed data.
   */

  decompressData(compressedData) {
    return zlib.inflateSync(compressedData);
  }
}

module.exports = fs;
