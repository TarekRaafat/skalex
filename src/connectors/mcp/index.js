/**
 * mcp/index.js  -  SkalexMCPServer
 *
 * Exposes a Skalex database as a set of MCP tools that AI agents (Claude
 * Desktop, Cursor, OpenClaw, custom agents) can call via the Model Context
 * Protocol.
 *
 * Instantiate via db.mcp(opts)  -  do not construct directly.
 *
 * Transports:
 *   stdio (default)  -  newline-delimited JSON on stdin/stdout
 *   http             -  HTTP server + SSE stream
 *
 * Access control:
 *   scopes: { collectionName | '*': ['read'] | ['read', 'write'] }
 *   'read'   -  find, search, ask, schema, collections
 *   'write'  -  insert, update, delete
 *
 * @example
 * // stdio (for Claude Desktop / Cursor tool config)
 * const server = db.mcp();
 * await server.listen();
 *
 * // HTTP + SSE
 * const server = db.mcp({ transport: 'http', port: 3456 });
 * await server.listen();
 */
import { TOOL_DEFS, callTool } from "./tools.js";
import { ok, error, parse, toolResult, toolError, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR } from "./protocol.js";
import HttpTransport from "./transports/http.js";
import StdioTransport from "./transports/stdio.js";

const SERVER_INFO = { name: "skalex", version: "4.0.0-alpha" };
const PROTOCOL_VERSION = "2024-11-05";

class SkalexMCPServer {
  /**
   * @param {object} db                           - Skalex instance.
   * @param {object} [opts]
   * @param {"stdio"|"http"} [opts.transport]     - Transport type. Default: "stdio".
   * @param {number}  [opts.port]                 - HTTP port. Default: 3000.
   * @param {string}  [opts.host]                 - HTTP host. Default: "127.0.0.1".
   * @param {object}  [opts.scopes]               - Access control map. Default: { "*": ["read"] } (read-only).
   * @param {string|null} [opts.allowedOrigin]    - CORS origin for HTTP transport. Default: null (disabled).
   * @param {number}  [opts.maxBodySize]          - Max POST body size in bytes for HTTP transport. Default: 1 MiB.
   */
  constructor(db, opts = {}) {
    this._db            = db;
    this._transport     = opts.transport     || "stdio";
    this._port          = opts.port          || 3000;
    this._host          = opts.host          || "127.0.0.1";
    this._allowedOrigin = opts.allowedOrigin ?? null;
    this._maxBodySize   = opts.maxBodySize   ?? 1_048_576;
    this._scopes        = opts.scopes        || { "*": ["read"] };
    this._t             = null; // active transport instance
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Start listening on the configured transport.
   * @returns {Promise<void>}
   */
  async listen() {
    if (this._transport === "http") {
      this._t = new HttpTransport({ port: this._port, host: this._host, allowedOrigin: this._allowedOrigin, maxBodySize: this._maxBodySize });
    } else {
      this._t = new StdioTransport();
    }

    this._t.onMessage(msg => this._handleMessage(msg));
    await this._t.start();
  }

  /**
   * Connect a custom transport (used in tests / embedding scenarios).
   * The transport must implement { onMessage(fn), send(msg), start() }.
   * @param {object} transport
   */
  async connect(transport) {
    this._t = transport;
    this._t.onMessage(msg => this._handleMessage(msg));
    if (typeof this._t.start === "function") await this._t.start();
  }

  /** Stop the server. */
  async close() {
    if (this._t && typeof this._t.stop === "function") await this._t.stop();
    this._t = null;
  }

  /** @returns {string} Transport type. */
  get transport() { return this._transport; }

  /** @returns {string|undefined} HTTP URL (http transport only). */
  get url() { return this._t?.url; }

  // ─── Message router ────────────────────────────────────────────────────────

  async _handleMessage(raw) {
    const { msg, parseError } = typeof raw === "string" ? parse(raw) : { msg: raw };
    if (parseError) { this._send(parseError); return; }

    const { id, method, params } = msg;

    // Notifications (no id)  -  acknowledge silently
    if (id === undefined) {
      if (method === "notifications/initialized") return;
      return;
    }

    try {
      switch (method) {
        case "initialize":
          this._send(ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }));
          break;

        case "tools/list":
          this._send(ok(id, { tools: this._visibleTools() }));
          break;

        case "tools/call":
          await this._handleToolCall(id, params);
          break;

        case "ping":
          this._send(ok(id, {}));
          break;

        default:
          this._send(error(id, METHOD_NOT_FOUND, `Method not found: ${method}`));
      }
    } catch (err) {
      this._send(error(id, INTERNAL_ERROR, err.message || "Internal error"));
    }
  }

  async _handleToolCall(id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (!name) {
      this._send(error(id, INVALID_PARAMS, "tools/call requires params.name"));
      return;
    }

    const def = TOOL_DEFS.find(t => t.name === name);
    if (!def) {
      this._send(error(id, METHOD_NOT_FOUND, `Unknown tool: ${name}`));
      return;
    }

    // Extract collection from args (most tools have one)
    const collection = args.collection || args.collection_name || null;

    if (!this._hasScope(collection, def.scope)) {
      this._send(ok(id, toolError(`Access denied: "${name}" requires "${def.scope}" scope on collection "${collection}".`)));
      return;
    }

    try {
      const result = await callTool(name, args, this._db);
      this._send(ok(id, toolResult(JSON.stringify(result, null, 2))));
    } catch (err) {
      this._send(ok(id, toolError(err.message || String(err))));
    }
  }

  // ─── Access control ────────────────────────────────────────────────────────

  /**
   * Return tool definitions visible to the current scope configuration.
   * Tools whose scope is not granted on any collection are excluded.
   */
  _visibleTools() {
    return TOOL_DEFS.filter(def => {
      // If the global wildcard grants the scope, show the tool
      const global = this._scopes["*"];
      if (global && (global.includes(def.scope) || global.includes("admin"))) return true;
      // If any collection-specific scope grants it, show the tool
      for (const [, perms] of Object.entries(this._scopes)) {
        if (perms.includes(def.scope) || perms.includes("admin")) return true;
      }
      return false;
    });
  }

  /**
   * Check whether a given scope is permitted for a collection.
   * @param {string|null} collection
   * @param {"read"|"write"|"admin"} scope
   * @returns {boolean}
   */
  _hasScope(collection, scope) {
    const check = perms =>
      perms.includes("admin") || perms.includes(scope);

    // collection-specific rule takes precedence over wildcard
    if (collection && this._scopes[collection]) {
      return check(this._scopes[collection]);
    }
    // fall back to wildcard
    if (this._scopes["*"]) {
      return check(this._scopes["*"]);
    }
    return false;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _send(msg) {
    this._t?.send(msg);
  }
}

export default SkalexMCPServer;
