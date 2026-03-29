/**
 * SessionStats — per-session read/write/lastActive tracking.
 *
 * Sessions are keyed by an arbitrary string ID passed via the `session`
 * option on mutation methods and find/search options.
 */
class SessionStats {
  constructor() {
    /** @type {Map<string, { reads: number, writes: number, lastActive: Date }>} */
    this._sessions = new Map();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _ensure(sessionId) {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, { reads: 0, writes: 0, lastActive: null });
    }
    return this._sessions.get(sessionId);
  }

  // ─── Record ───────────────────────────────────────────────────────────────

  /**
   * Record a read operation for a session.
   * No-op if sessionId is falsy.
   * @param {string|null|undefined} sessionId
   */
  recordRead(sessionId) {
    if (!sessionId) return;
    const s = this._ensure(sessionId);
    s.reads++;
    s.lastActive = new Date();
  }

  /**
   * Record a write operation for a session.
   * No-op if sessionId is falsy.
   * @param {string|null|undefined} sessionId
   */
  recordWrite(sessionId) {
    if (!sessionId) return;
    const s = this._ensure(sessionId);
    s.writes++;
    s.lastActive = new Date();
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Return stats for a single session, or null if not found.
   * @param {string} sessionId
   * @returns {{ sessionId: string, reads: number, writes: number, lastActive: Date } | null}
   */
  get(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    return { sessionId, ...s };
  }

  /**
   * Return stats for all tracked sessions.
   * @returns {Array<{ sessionId: string, reads: number, writes: number, lastActive: Date }>}
   */
  all() {
    return [...this._sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      ...s,
    }));
  }

  /**
   * Clear stats for one session (or all sessions if no ID given).
   * @param {string} [sessionId]
   */
  clear(sessionId) {
    if (sessionId) {
      this._sessions.delete(sessionId);
    } else {
      this._sessions.clear();
    }
  }
}

module.exports = SessionStats;
