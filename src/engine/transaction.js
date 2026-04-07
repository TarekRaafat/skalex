/**
 * transaction.js  -  TransactionManager for Skalex.
 *
 * Owns transaction scope, lazy snapshots, timeout/abort protection,
 * deferred side effects, and rollback.
 */
import { TransactionError } from "./errors.js";

let _txIdCounter = 0;

class TransactionManager {
  constructor() {
    this._txLock = Promise.resolve();
    /** @type {TransactionContext|null} Current active transaction context. */
    this._ctx = null;
    /** @type {Set<number>} IDs of aborted transactions - stale continuations checked against this. */
    this._abortedIds = new Set();
  }

  /** Whether a transaction is currently active. */
  get active() {
    return this._ctx !== null && !this._ctx.aborted;
  }

  /** The current transaction context (or null). */
  get context() {
    return this._ctx;
  }

  /**
   * Run a callback inside a transaction.
   *
   * Lazy snapshots: only collections touched by a write are snapshotted,
   * on first mutation - not all collections upfront.
   *
   * @param {Function} fn            - (proxy) => Promise<any>
   * @param {object}   db            - The Skalex instance.
   * @param {object}   opts
   * @param {number}   [opts.timeout] - Max ms before abort. 0 = no timeout.
   * @returns {Promise<any>}
   */
  async run(fn, db, { timeout = 0 } = {}) {
    const execute = async () => {
      await db._ensureConnected();

      // Track which collections existed before the transaction
      const preExisting = new Set(Object.keys(db.collections));

      const ctx = {
        id: ++_txIdCounter,
        startedAt: Date.now(),
        aborted: false,
        preExisting,
        touchedCollections: new Set(),
        snapshots: new Map(),
        deferredEffects: [],
        timeout,
      };

      this._ctx = ctx;

      // Timeout mechanism
      let timer = null;
      let timeoutReject = null;
      const timeoutPromise = timeout > 0
        ? new Promise((_, reject) => {
          timeoutReject = reject;
          timer = setTimeout(() => {
            ctx.aborted = true;
            reject(new TransactionError(
              "ERR_SKALEX_TX_TIMEOUT",
              `Transaction ${ctx.id} timed out after ${timeout}ms`
            ));
          }, timeout);
        })
        : null;

      // Proxy to intercept direct collections access
      const proxy = new Proxy(db, {
        get(target, prop) {
          if (prop === "collections") throw new TransactionError(
            "ERR_SKALEX_TX_DIRECT_ACCESS",
            "Direct access to db.collections inside transaction() is not covered by rollback. Use the collection API (db.useCollection) instead."
          );
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      try {
        const fnPromise = fn(proxy);
        const result = timeoutPromise
          ? await Promise.race([fnPromise, timeoutPromise])
          : await fnPromise;

        if (ctx.aborted) {
          throw new TransactionError("ERR_SKALEX_TX_ABORTED", `Transaction ${ctx.id} was aborted`);
        }

        // Commit: persist only touched collections
        const touched = [...ctx.touchedCollections];
        if (touched.length > 0) {
          await db._persistence.saveAtomic(db.collections, touched);
        }

        // Flush deferred side effects after successful commit
        for (const effect of ctx.deferredEffects) await effect();

        return result;
      } catch (error) {
        // Rollback: restore snapshotted pre-existing collections
        for (const [name, snap] of ctx.snapshots) {
          if (ctx.preExisting.has(name)) {
            db._applySnapshot(name, snap);
            // Restore the dirty flag to its pre-transaction state
            if (db.collections[name]) db.collections[name]._dirty = snap._dirty;
          }
        }
        // Remove ALL collections that didn't exist before the transaction
        for (const name in db.collections) {
          if (!ctx.preExisting.has(name)) {
            delete db.collections[name];
            delete db._collectionInstances[name];
          }
        }

        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        // Always clear context. Stale async continuations are caught by
        // assertNotAborted() via _abortedIds, not by leaving _ctx set.
        if (ctx.aborted) this._abortedIds.add(ctx.id);
        this._ctx = null;

        // Clear _createdInTxId on any cached Collection instances stamped
        // with this transaction, so they are not permanently poisoned.
        for (const name in db._collectionInstances) {
          const inst = db._collectionInstances[name];
          if (inst._createdInTxId === ctx.id) inst._createdInTxId = null;
        }
      }
    };

    // Serialise concurrent transactions via promise-chain lock
    const next = this._txLock.then(execute);
    this._txLock = next.catch(() => { });
    return next;
  }

  /**
   * Lazily snapshot a collection on first write within the transaction.
   * Must be called by every mutating code path before touching state.
   *
   * @param {string} name
   * @param {object} col - The collection store object.
   * @param {Function} snapshotFn - (col) => { data, index }
   */
  snapshotIfNeeded(name, col, snapshotFn) {
    const ctx = this._ctx;
    if (!ctx) return;

    this._assertCtxNotAborted(ctx);

    if (!ctx.snapshots.has(name)) {
      const snap = snapshotFn(col);
      snap._dirty = col._dirty ?? false;
      ctx.snapshots.set(name, snap);
    }
    ctx.touchedCollections.add(name);
  }

  /**
   * Assert the current transaction has not been aborted.
   * No-op when called outside a transaction - only active transactions
   * are checked, so non-transactional writes are never blocked.
   * @throws {TransactionError} if aborted
   */
  assertNotAborted() {
    const ctx = this._ctx;
    if (ctx) this._assertCtxNotAborted(ctx);
  }

  /**
   * Check if a specific context is aborted, or if a stale continuation
   * from a previously aborted transaction is trying to mutate.
   * @param {object} ctx
   */
  _assertCtxNotAborted(ctx) {
    if (ctx.aborted) {
      throw new TransactionError(
        "ERR_SKALEX_TX_ABORTED",
        `Transaction ${ctx.id} was aborted. No further mutations allowed.`
      );
    }
  }

  /**
   * Queue a side effect for after-commit execution.
   * If not in a transaction, executes immediately.
   * @param {Function} effect - async () => void
   * @returns {boolean} true if deferred, false if executed immediately
   */
  defer(effect) {
    if (this._ctx) {
      this._ctx.deferredEffects.push(effect);
      return true;
    }
    return false;
  }
}

export default TransactionManager;
