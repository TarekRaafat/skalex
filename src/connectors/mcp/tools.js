/**
 * tools.js  -  MCP tool definitions and handlers for Skalex.
 *
 * Each tool exposes one Skalex operation to an AI agent.
 * The handler receives (db, args) and returns a plain value that is
 * JSON-serialised into the MCP content text.
 *
 * Tools:
 *   collections  -  list all collections
 *   schema       -  get schema for a collection
 *   find         -  find documents
 *   insert       -  insert a document
 *   update       -  update matching documents
 *   delete       -  delete matching documents
 *   search       -  semantic similarity search (requires embedding adapter)
 *   ask          -  natural-language query (requires AI adapter)
 *
 * Scopes:
 *   read   -  collections, schema, find, search, ask
 *   write  -  insert, update, delete
 */
import { ValidationError } from "../../engine/errors.js";

/**
 * Maximum allowed depth of a filter tree sanitized from agent input.
 * Real filters rarely exceed 3-4 levels (`$or` → branch → field op); 16
 * gives 4× headroom for complex compound queries. Deeper trees are
 * almost certainly malicious (stack-overflow attempts) or buggy and are
 * rejected with a stable error code.
 */
const MAX_FILTER_DEPTH = 16;

/**
 * Validate a collection name supplied by an AI agent.
 * Rejects names containing path separators or traversal sequences that could
 * escape the data directory when the name is used to construct a file path.
 * @param {string} name
 * @returns {string} The validated name
 */
function _validateCollection(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_MCP_COLLECTION",
      "collection name must be a non-empty string",
      { name }
    );
  }
  if (/[/\\]/.test(name) || name.includes("..") || name.includes("\0")) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_MCP_COLLECTION",
      `invalid collection name: "${name}"`,
      { name }
    );
  }
  if (name.trim().startsWith("_")) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_MCP_COLLECTION",
      `access to system collection "${name}" is not permitted`,
      { name }
    );
  }
  return name.trim();
}

/**
 * Sanitize an MCP-sourced filter. Handles `$fn` according to the registered
 * predicates allowlist:
 *
 * - If `predicates` is provided and `$fn` is a string matching a registered
 *   name, the string is replaced with the real function. The agent gets
 *   `$fn` power without code crossing the wire.
 * - If `$fn` is a string that does NOT match a registered name, it is
 *   stripped and a warning is logged.
 * - If `$fn` is anything other than a string (a function, an object, code),
 *   it is stripped regardless of predicates.
 * - If no `predicates` map is provided, all `$fn` keys are stripped
 *   (alpha.3 default behavior).
 *
 * Traverses into `$or`, `$and`, `$not` branches. Enforces a maximum
 * traversal depth ({@link MAX_FILTER_DEPTH}) so an adversarial agent
 * cannot send a deeply nested payload to blow the call stack.
 *
 * @param {*} filter
 * @param {(msg: string, level?: string) => void} [logger]
 * @param {number} [depth=0] - Current recursion depth (internal).
 * @param {Record<string, Function>} [predicates] - Named predicate allowlist.
 * @returns {*} A new filter with `$fn` keys resolved, stripped, or kept.
 * @throws {ValidationError} ERR_SKALEX_VALIDATION_FILTER_DEPTH when the
 *   filter tree nests deeper than {@link MAX_FILTER_DEPTH}.
 */
function sanitizeFilter(filter, logger, depth = 0, predicates = null) {
  if (depth > MAX_FILTER_DEPTH) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_FILTER_DEPTH",
      `Filter nested too deeply (> ${MAX_FILTER_DEPTH} levels). This limit ` +
      `protects against stack-overflow attacks from agent-supplied filters.`,
      { maxDepth: MAX_FILTER_DEPTH }
    );
  }
  if (filter === null || typeof filter !== "object") return filter;
  if (Array.isArray(filter)) return filter.map(f => sanitizeFilter(f, logger, depth + 1, predicates));
  const out = {};
  for (const key of Object.keys(filter)) {
    if (key === "$fn") {
      const val = filter[key];
      // Only string names can be resolved against the allowlist.
      // Functions, objects, and code strings are always stripped.
      if (typeof val === "string" && predicates && val in predicates) {
        out[key] = predicates[val];
        continue;
      }
      if (logger) logger(`[MCP] $fn stripped from agent-supplied filter`, "warn");
      continue;
    }
    out[key] = sanitizeFilter(filter[key], logger, depth + 1, predicates);
  }
  return out;
}

const TOOL_DEFS = [
  {
    name: "skalex_collections",
    description: "List all collection names in the database.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    scope: "read",
  },
  {
    name: "skalex_schema",
    description: "Return the schema for a collection as a { field: type } map. Returns null if the collection is empty.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
      },
      required: ["collection"],
    },
    scope: "read",
  },
  {
    name: "skalex_find",
    description: "Find documents in a collection that match a filter.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        filter:     { type: "object", description: "Query filter (MongoDB-style operators supported)." },
        limit:      { type: "number", description: "Maximum number of results. Default: 20." },
        sort:       { type: "object", description: "Sort descriptor: { field: 1 } for ascending, { field: -1 } for descending." },
      },
      required: ["collection"],
    },
    scope: "read",
  },
  {
    name: "skalex_insert",
    description: "Insert a single document into a collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        doc:        { type: "object", description: "Document to insert." },
      },
      required: ["collection", "doc"],
    },
    scope: "write",
  },
  {
    name: "skalex_update",
    description: "Update the first document matching a filter.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        filter:     { type: "object", description: "Query filter to identify the document." },
        update:     { type: "object", description: "Fields to update (direct assignment, $inc, $push supported)." },
        many:       { type: "boolean", description: "If true, update all matching documents. Default: false." },
      },
      required: ["collection", "filter", "update"],
    },
    scope: "write",
  },
  {
    name: "skalex_delete",
    description: "Delete the first document matching a filter.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        filter:     { type: "object", description: "Query filter to identify the document." },
        many:       { type: "boolean", description: "If true, delete all matching documents. Default: false." },
      },
      required: ["collection", "filter"],
    },
    scope: "write",
  },
  {
    name: "skalex_search",
    description: "Semantic similarity search. Requires an embedding adapter to be configured.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        query:      { type: "string", description: "Natural-language query string to embed and compare." },
        limit:      { type: "number", description: "Maximum number of results. Default: 10." },
        minScore:   { type: "number", description: "Minimum cosine similarity score [0, 1]. Default: 0." },
        filter:     { type: "object", description: "Optional structured pre-filter (hybrid search)." },
      },
      required: ["collection", "query"],
    },
    scope: "read",
  },
  {
    name: "skalex_ask",
    description: "Translate a natural-language question into a filter and query a collection. Requires a language model adapter.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        question:   { type: "string", description: "Natural-language question about the data." },
        limit:      { type: "number", description: "Maximum number of results. Default: 20." },
      },
      required: ["collection", "question"],
    },
    scope: "read",
  },
];

/**
 * Execute a tool call.
 * @param {string} name - Tool name.
 * @param {object} args - Tool arguments.
 * @param {object} db   - Skalex instance.
 * @param {Record<string, Function>|null} [predicates] - Named predicate allowlist.
 * @returns {Promise<object>} Plain value to be JSON.stringify'd into content text.
 */
async function callTool(name, args, db, predicates = null) {
  const log = db._logger;
  const _sanitize = (f) => sanitizeFilter(f, log, 0, predicates);
  switch (name) {
    case "skalex_collections":
      return Object.keys(db.collections).filter(n => !n.startsWith("_"));

    case "skalex_schema": {
      const s = db.schema(_validateCollection(args.collection));
      return s ?? null;
    }

    case "skalex_find": {
      const col = db.useCollection(_validateCollection(args.collection));
      const opts = {};
      if (args.limit) opts.limit = args.limit;
      if (args.sort)  opts.sort  = args.sort;
      return col.find(_sanitize(args.filter || {}), opts);
    }

    case "skalex_insert": {
      const col = db.useCollection(_validateCollection(args.collection));
      return col.insertOne(args.doc || {});
    }

    case "skalex_update": {
      const col = db.useCollection(_validateCollection(args.collection));
      const filter = _sanitize(args.filter || {});
      if (args.many) return col.updateMany(filter, args.update || {});
      return col.updateOne(filter, args.update || {});
    }

    case "skalex_delete": {
      const col = db.useCollection(_validateCollection(args.collection));
      const filter = _sanitize(args.filter || {});
      if (args.many) return col.deleteMany(filter);
      return col.deleteOne(filter);
    }

    case "skalex_search": {
      const col = db.useCollection(_validateCollection(args.collection));
      return col.search(args.query, {
        limit:    args.limit    ?? 10,
        minScore: args.minScore ?? 0,
        filter:   _sanitize(args.filter),
      });
    }

    case "skalex_ask":
      return db.ask(_validateCollection(args.collection), args.question, { limit: args.limit ?? 20 });

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "NOT_FOUND" });
  }
}

export { TOOL_DEFS, callTool, sanitizeFilter };
