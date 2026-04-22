/**
 * Connectors barrel  -  single import for all storage adapters.
 *
 * npm / bundler usage:
 *   import { FsAdapter, LocalStorageAdapter, EncryptedAdapter } from 'skalex/connectors';
 *
 * CDN / browser ESM usage (browser-compatible adapters only):
 *   import { LocalStorageAdapter, EncryptedAdapter }
 *     from 'https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha.5/src/connectors/storage/browser.js';
 *
 * Platform-specific adapters (BunSQLiteAdapter, D1Adapter, LibSQLAdapter) are included
 * here for bundler users  -  tree-shaking removes any that are not imported. They access
 * platform APIs lazily at runtime, so no static import errors occur in other environments.
 */
export { default as StorageAdapter }      from "./base.js";
export { default as FsAdapter }          from "./fs.js";
export { default as LocalStorageAdapter } from "./local.js";
export { default as EncryptedAdapter }    from "./encrypted.js";
export { default as BunSQLiteAdapter }    from "./bun-sqlite.js";
export { default as D1Adapter }           from "./d1.js";
export { default as LibSQLAdapter }       from "./libsql.js";
