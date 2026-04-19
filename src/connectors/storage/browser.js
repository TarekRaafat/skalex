/**
 * Browser connectors barrel  -  single import for CDN / browser ESM usage.
 *
 * Usage:
 *   import { LocalStorageAdapter, EncryptedAdapter }
 *     from "https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha.4/src/connectors/storage/browser.js";
 *
 * Only browser-compatible connectors are exported here.
 * Node / edge connectors (FsAdapter, BunSQLiteAdapter, D1Adapter, LibSQLAdapter)
 * require platform APIs unavailable in browsers and are not included.
 */
export { default as LocalStorageAdapter } from "./local.js";
export { default as EncryptedAdapter }    from "./encrypted.js";
