/**
 * EncryptedAdapter  -  wraps any StorageAdapter with AES-256-GCM encryption.
 *
 * All data written to the underlying adapter is encrypted; reads are decrypted
 * transparently. The encryption layer is completely invisible to callers.
 *
 * Algorithm : AES-256-GCM
 * IV         : 12 random bytes per write (GCM recommendation)
 * Auth tag   : 128-bit, appended to ciphertext
 * Wire format: base64( iv[12] | ciphertext+tag[n+16] )
 *
 * Uses the Web Crypto API (globalThis.crypto.subtle) which is available in
 * Node.js ≥18, Bun, Deno, and all modern browsers  -  no extra dependencies.
 *
 * Key formats accepted:
 *   - 64-character hex string  (32 bytes)
 *   - Uint8Array / Buffer      (32 bytes)
 */
import StorageAdapter from "./base.js";

const ALGO    = "AES-GCM";
const IV_LEN  = 12;   // bytes  -  recommended for GCM
const KEY_LEN = 32;   // bytes  -  AES-256

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

class EncryptedAdapter extends StorageAdapter {
  /**
   * @param {StorageAdapter} adapter    - Underlying storage backend.
   * @param {string|Uint8Array} key     - 256-bit key (hex string or bytes).
   */
  constructor(adapter, key) {
    super();
    this._adapter = adapter;
    this._rawKey = typeof key === "string" ? _hexToBytes(key) : Uint8Array.from(key);

    if (this._rawKey.length !== KEY_LEN) {
      throw new Error(
        `EncryptedAdapter: key must be ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars), got ${this._rawKey.length}`
      );
    }

    this._cryptoKey = null; // lazily imported CryptoKey
  }

  async read(name) {
    const raw = await this._adapter.read(name);
    if (!raw) return null;
    return this._decrypt(raw);
  }

  async write(name, data) {
    return this._adapter.write(name, await this._encrypt(data));
  }

  async delete(name) {
    return this._adapter.delete(name);
  }

  async list() {
    return this._adapter.list();
  }

  // ─── FsAdapter extension passthrough ────────────────────────────────────────
  // These stubs forward optional FsAdapter-specific methods (used by export/import).

  join(...args) { return this._adapter.join?.(...args); }
  ensureDir(dir) { return this._adapter.ensureDir?.(dir); }

  async writeRaw(path, data) {
    return this._adapter.writeRaw?.(path, await this._encrypt(data));
  }

  async readRaw(path) {
    const raw = await this._adapter.readRaw?.(path);
    if (!raw) return null;
    return this._decrypt(raw);
  }

  // ─── Crypto ──────────────────────────────────────────────────────────────────

  async _getKey() {
    if (!this._cryptoKey) {
      this._cryptoKey = await globalThis.crypto.subtle.importKey(
        "raw",
        this._rawKey,
        { name: ALGO },
        false,
        ["encrypt", "decrypt"]
      );
    }
    return this._cryptoKey;
  }

  async _encrypt(plaintext) {
    const key = await this._getKey();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
    const encoded = _encoder.encode(plaintext);

    const cipherBuf = await globalThis.crypto.subtle.encrypt(
      { name: ALGO, iv, tagLength: 128 },
      key,
      encoded
    );

    // Wire format: iv (12 bytes) | ciphertext + auth-tag (n+16 bytes)
    const combined = new Uint8Array(IV_LEN + cipherBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuf), IV_LEN);

    return _toBase64(combined);
  }

  async _decrypt(base64) {
    const key = await this._getKey();
    const combined = _fromBase64(base64);
    const iv = combined.slice(0, IV_LEN);
    const cipherWithTag = combined.slice(IV_LEN);

    const plainBuf = await globalThis.crypto.subtle.decrypt(
      { name: ALGO, iv, tagLength: 128 },
      key,
      cipherWithTag
    );

    return _decoder.decode(plainBuf);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _hexToBytes(hex) {
  if (hex.length !== KEY_LEN * 2) {
    throw new Error(
      `EncryptedAdapter: hex key must be ${KEY_LEN * 2} characters (${KEY_LEN} bytes)`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("EncryptedAdapter: hex key contains invalid characters");
  }
  const bytes = new Uint8Array(KEY_LEN);
  for (let i = 0; i < KEY_LEN; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function _toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return globalThis.btoa(bin);
}

function _fromBase64(base64) {
  const bin = globalThis.atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export default EncryptedAdapter;
