import nodeCrypto from "node:crypto";

/**
 * Generates a unique ID.
 * @returns {string} The unique ID.
 */
function generateUniqueId() {
  const timestamp = Date.now().toString(16);

  let random;
  try {
    random = nodeCrypto.randomBytes(8).toString("hex");
  } catch {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    random = Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  return `${timestamp}${random}`.substring(0, 24);
}

/**
 * Logs a message or Error to the console.
 * @param {string|Error} error - Message string or Error object to log.
 * @param {"error"|undefined} type - Pass "error" to route to console.error.
 */
function logger(error, type) {
  const msg = error instanceof Error ? error.message : error;

  if (type === "error") {
    console.error(msg);
  } else {
    console.log(msg);
  }
}

/**
 * Resolve a dot-notation field path on an object.
 * Returns undefined if any intermediate segment is null/undefined.
 * @param {object} obj
 * @param {string} path  - e.g. "address.city"
 * @returns {unknown}
 */
const _FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function resolveDotPath(obj, path) {
  if (!path.includes(".")) {
    if (_FORBIDDEN_KEYS.has(path)) return undefined;
    return obj[path];
  }
  let cur = obj;
  for (const p of path.split(".")) {
    if (_FORBIDDEN_KEYS.has(p)) return undefined;
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export { generateUniqueId, logger, resolveDotPath };
