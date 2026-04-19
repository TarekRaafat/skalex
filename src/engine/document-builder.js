import { computeExpiry } from "./ttl.js";
import { generateUniqueId } from "./utils.js";
import { AdapterError } from "./errors.js";

/**
 * Build a new document from a raw item: assign _id/timestamps, apply TTL,
 * embed vector, and set initial _version when versioning is on.
 *
 * @param {object} item - Raw user-supplied document.
 * @param {object} opts
 * @param {number|string} [opts.ttl] - Per-doc TTL override.
 * @param {string|Function} [opts.embed] - Per-doc embed override.
 * @param {number|string} [opts.defaultTtl] - Collection-level TTL default.
 * @param {string|Function} [opts.defaultEmbed] - Collection-level embed default.
 * @param {boolean} [opts.versioning] - Whether versioning is enabled.
 * @param {Function|null} [opts.idGenerator] - Custom ID generator or null.
 * @param {Function} [opts.embedFn] - async (text) => number[].
 * @returns {Promise<object>}
 */
async function buildDoc(item, { ttl, embed, defaultTtl, defaultEmbed, versioning, idGenerator, embedFn } = {}) {
  const newItem = {
    ...item,
    _id: item._id ?? (idGenerator ?? generateUniqueId)(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const resolvedTtl = ttl ?? defaultTtl;
  if (resolvedTtl) newItem._expiresAt = computeExpiry(resolvedTtl);

  const resolvedEmbed = embed ?? defaultEmbed;
  if (resolvedEmbed) {
    if (typeof embedFn !== "function") {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_EMBEDDING_REQUIRED",
        "Document embedding requires an AI adapter. Pass { ai: { provider, apiKey } } to the Skalex constructor.",
      );
    }
    const text = typeof resolvedEmbed === "function" ? resolvedEmbed(newItem) : newItem[resolvedEmbed];
    newItem._vector = await embedFn(String(text));
  }

  if (versioning) newItem._version = 1;

  return newItem;
}

export { buildDoc };
