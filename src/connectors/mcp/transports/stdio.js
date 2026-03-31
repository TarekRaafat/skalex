import { error as protocolError, PARSE_ERROR } from "../protocol.js";

/**
 * transports/stdio.js — stdio transport for the MCP server.
 *
 * Reads newline-delimited JSON-RPC messages from stdin and writes
 * responses to stdout. This is the standard MCP transport used by
 * Claude Desktop, Cursor, and other AI tools that spawn local servers.
 *
 * Protocol:
 *   stdin  → one JSON object per line (client → server)
 *   stdout → one JSON object per line (server → client)
 */
class StdioTransport {
  constructor() {
    this._onMessage = null;
    this._buffer    = "";
    this._started   = false;
  }

  /**
   * Register the message handler.
   * @param {(msg: object) => Promise<void>} fn
   */
  onMessage(fn) {
    this._onMessage = fn;
  }

  /**
   * Send a message (server → client).
   * @param {object} msg
   */
  send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  /** Start listening on stdin. Idempotent. */
  start() {
    if (this._started) return;
    this._started = true;

    process.stdin.setEncoding("utf8");

    process.stdin.on("data", chunk => {
      this._buffer += chunk;
      let idx;
      while ((idx = this._buffer.indexOf("\n")) !== -1) {
        const line = this._buffer.slice(0, idx).trim();
        this._buffer = this._buffer.slice(idx + 1);
        if (line && this._onMessage) {
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (_) {
            this.send(protocolError(null, PARSE_ERROR, "Parse error"));
            continue;
          }
          this._onMessage(msg).catch(() => {});
        }
      }
    });

    process.stdin.on("end", () => {
      process.exit(0);
    });
  }

  /** Stop the transport (remove stdin listeners). */
  stop() {
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("end");
    this._started = false;
  }
}

export default StdioTransport;
