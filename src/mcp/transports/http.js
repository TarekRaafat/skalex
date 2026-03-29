/**
 * transports/http.js — HTTP + SSE transport for the MCP server.
 *
 * Implements the MCP HTTP/SSE transport:
 *   GET  /sse      — establishes a persistent SSE stream (server → client)
 *   POST /message  — receives JSON-RPC requests from the client
 *
 * Uses Node's built-in `http` module — zero extra dependencies.
 *
 * Multiple simultaneous SSE clients are supported; each receives all
 * server-sent messages (broadcast model).
 */
const http = require("http");

class HttpTransport {
  /**
   * @param {{ port?: number, host?: string }} [opts]
   */
  constructor({ port = 3000, host = "127.0.0.1" } = {}) {
    this._port    = port;
    this._host    = host;
    this._clients = new Set(); // active SSE response objects
    this._onMessage = null;
    this._server  = null;
  }

  /**
   * Register the message handler.
   * @param {(msg: object) => Promise<void>} fn
   */
  onMessage(fn) {
    this._onMessage = fn;
  }

  /**
   * Broadcast a message to all connected SSE clients.
   * @param {object} msg
   */
  send(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this._clients) {
      try { res.write(data); } catch (_) { this._clients.delete(res); }
    }
  }

  /**
   * Start the HTTP server.
   * @returns {Promise<void>} Resolves when the server is listening.
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => {
        // CORS headers for browser clients
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "GET" && req.url === "/sse") {
          this._handleSSE(req, res);
        } else if (req.method === "POST" && req.url === "/message") {
          this._handleMessage(req, res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
      });

      this._server.on("error", reject);
      this._server.listen(this._port, this._host, () => resolve());
    });
  }

  /** Stop the HTTP server. */
  stop() {
    return new Promise(resolve => {
      if (!this._server) { resolve(); return; }
      for (const res of this._clients) {
        try { res.end(); } catch (_) {}
      }
      this._clients.clear();
      this._server.close(() => resolve());
      this._server = null;
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _handleSSE(req, res) {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    });
    // MCP requires the server to send an initial endpoint event with the
    // POST URL so the client knows where to send messages.
    res.write(`event: endpoint\ndata: /message\n\n`);

    this._clients.add(res);

    req.on("close", () => { this._clients.delete(res); });
  }

  async _handleMessage(req, res) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; });
    req.on("end", async () => {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end("{}");

      let msg;
      try {
        msg = JSON.parse(body);
      } catch (_) {
        const { error, PARSE_ERROR } = require("../protocol.js");
        this.send(error(null, PARSE_ERROR, "Parse error"));
        return;
      }

      if (this._onMessage) {
        await this._onMessage(msg).catch(() => {});
      }
    });
  }

  get port()  { return this._port; }
  get host()  { return this._host; }
  get url()   { return `http://${this._host}:${this._port}`; }
  get sseUrl(){ return `${this.url}/sse`; }
}

module.exports = HttpTransport;
