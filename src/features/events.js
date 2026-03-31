/**
 * events.js — lightweight cross-runtime event bus.
 *
 * Provides pub/sub for collection mutation events consumed by watch() and
 * any other internal subscribers. No Node.js EventEmitter dependency —
 * works identically in Node, Bun, Deno, and browsers.
 *
 * Event names are collection names. Subscribers receive a MutationEvent:
 *   { op, collection, doc, prev? }
 */
class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to events for `event`.
   * Returns an unsubscribe function.
   * @param {string} event
   * @param {Function} fn
   * @returns {() => void}
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  /**
   * Unsubscribe a specific listener.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  /**
   * Emit an event to all subscribers. Fires both the specific channel and
   * any wildcard ("*") listeners. Errors in listeners are swallowed to
   * prevent a bad subscriber from breaking a mutation.
   * @param {string} event
   * @param {object} data
   */
  emit(event, data) {
    for (const key of [event, "*"]) {
      const fns = this._listeners.get(key);
      if (!fns) continue;
      for (const fn of fns) {
        try { fn(data); } catch (_) { /* swallow — watcher errors must not break writes */ }
      }
    }
  }

  /**
   * Remove all listeners for an event, or all listeners if omitted.
   * @param {string} [event]
   */
  removeAll(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }

  /**
   * @param {string} event
   * @returns {number}
   */
  listenerCount(event) {
    return this._listeners.get(event)?.size ?? 0;
  }
}

export default EventBus;
