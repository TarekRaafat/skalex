import { AdapterError, QueryError } from "./errors.js";
import { matchesFilter } from "./query.js";

/**
 * Export filtered collection data to a file via the storage adapter.
 *
 * @param {object[]} data - The collection's data array.
 * @param {string} collectionName
 * @param {object} filter - Query filter.
 * @param {object} opts
 * @param {string} [opts.dir] - Export directory override.
 * @param {string} [opts.name] - File name override.
 * @param {"json"|"csv"} [opts.format="json"]
 * @param {object} ctx - Collection context with fs, dataDirectory, logger.
 * @returns {Promise<void>}
 */
async function exportData(data, collectionName, filter, { dir, name, format = "json" } = {}, ctx) {
  try {
    const filteredData = data.filter(item => matchesFilter(item, filter));

    if (filteredData.length === 0) {
      throw new QueryError("ERR_SKALEX_QUERY_EXPORT_EMPTY", `export(): no documents matched the filter in "${collectionName}"`, { collection: collectionName });
    }

    let content;
    if (format === "json") {
      content = JSON.stringify(filteredData, null, 2);
    } else {
      const escapeCsv = (v) => {
        if (v == null) return "";
        const s = (typeof v === "object") ? JSON.stringify(v) : String(v);
        // Escape if value contains comma, quote, or newline (RFC 4180)
        return (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r"))
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = Object.keys(filteredData[0]).map(escapeCsv).join(",");
      const rows = filteredData.map(item =>
        Object.values(item).map(escapeCsv).join(",")
      );
      content = [header, ...rows].join("\n");
    }

    if (typeof ctx.fs.writeRaw !== "function") {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_NO_RAW_WRITE",
        `export() requires a file-system adapter (FsAdapter). The current adapter does not support raw file writes.`
      );
    }

    const exportDir = dir || `${ctx.dataDirectory}/exports`;
    const fileName = `${name || collectionName}.${format}`;
    const filePath = ctx.fs.join(exportDir, fileName);

    ctx.fs.ensureDir(exportDir);
    await ctx.fs.writeRaw(filePath, content);
  } catch (error) {
    ctx.logger(`Error exporting "${collectionName}": ${error.message}`, "error");
    throw error;
  }
}

export { exportData };
