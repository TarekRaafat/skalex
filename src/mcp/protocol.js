/**
 * protocol.js — JSON-RPC 2.0 helpers for the MCP server.
 *
 * MCP (Model Context Protocol) uses JSON-RPC 2.0 as its wire format.
 * These helpers build compliant response/error objects and parse incoming
 * messages without any external dependencies.
 */

const JSONRPC = "2.0";

// Standard JSON-RPC error codes
const PARSE_ERROR      = -32700;
const INVALID_REQUEST  = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS   = -32602;
const INTERNAL_ERROR   = -32603;

/**
 * Build a success response.
 * @param {number|string|null} id
 * @param {object} result
 * @returns {object}
 */
function ok(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}

/**
 * Build an error response.
 * @param {number|string|null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {object}
 */
function error(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: JSONRPC, id, error: err };
}

/**
 * Parse a raw string into a JSON-RPC message.
 * Returns { msg } on success or { parseError } on failure.
 * @param {string} raw
 * @returns {{ msg?: object, parseError?: object }}
 */
function parse(raw) {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null || msg.jsonrpc !== JSONRPC) {
      return { parseError: error(null, INVALID_REQUEST, "Invalid JSON-RPC request") };
    }
    return { msg };
  } catch (_) {
    return { parseError: error(null, PARSE_ERROR, "Parse error") };
  }
}

/**
 * Build a tool-call success result.
 * MCP tools return content arrays: [{ type: "text", text: string }]
 * @param {string} text
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
function toolResult(text) {
  return { content: [{ type: "text", text }] };
}

/**
 * Build a tool-call error result.
 * @param {string} message
 * @returns {{ content: Array<{ type: string, text: string }>, isError: true }}
 */
function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

module.exports = {
  ok,
  error,
  parse,
  toolResult,
  toolError,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
};
