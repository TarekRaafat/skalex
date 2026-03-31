/**
 * MockTransport — in-memory MCP transport for unit tests.
 *
 * Usage:
 *   const t = new MockTransport();
 *   await server.connect(t);
 *   await t.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { ... } });
 *   expect(t.lastSent()).toMatchObject({ result: { ... } });
 */
class MockTransport {
  constructor() {
    this._handler = null;
    this._sent    = [];
  }

  /** Called by the server to register its message handler. */
  onMessage(fn) {
    this._handler = fn;
  }

  /** Called by the server to send a message to the client. */
  send(msg) {
    this._sent.push(msg);
  }

  /** start() is a no-op for the mock. */
  start() {}

  // ─── Test helpers ─────────────────────────────────────────────────────────

  /**
   * Simulate a client message arriving at the server.
   * @param {object} msg - JSON-RPC message object.
   * @returns {Promise<void>}
   */
  async receive(msg) {
    if (this._handler) await this._handler(msg);
  }

  /** All messages the server has sent so far. */
  get sent() { return this._sent; }

  /** Last message the server sent. */
  lastSent() { return this._sent[this._sent.length - 1]; }

  /** Clear the sent log. */
  clear() { this._sent = []; }
}

export default MockTransport;
