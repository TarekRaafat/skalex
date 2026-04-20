/**
 * transaction.js  -  TransactionManager for Skalex.
 *
 * Owns transaction scope, lazy snapshots, timeout/abort protection,
 * deferred side effects, and rollback.
 */
import { TransactionError, ValidationError } from "./errors.js";

/** Default window of aborted transaction IDs retained for stale-continuation detection. */
const DEFAULT_ABORTED_ID_WINDOW = 1000;

/** Collection methods that go through the MutationPipeline and need the depth counter. */
const _MUTATION_METHODS = Object.freeze(new Set([
  "insertOne", "insertMany", "updateOne", "updateMany",
  "upsert", "upsertMany", "deleteOne", "deleteMany", "restore",
]));

/**
 * Valid values for the `deferredEffectErrors` option. Exported so the
 * Skalex constructor and the per-transaction option path share a single
 * source of truth and neither can drift from the other.
 */
export const DEFERRED_EFFECT_STRATEGIES = /** @type {const} */ (["throw", "warn", "ignore"]);

/**
 * Validate a `deferredEffectErrors` value. Throws `ValidationError` with a
 * stable code when the value is defined but not one of the supported
 * strategies. `undefined` is allowed (caller will fall back to a default).
 * @param {unknown} value
 * @param {string} source - Human-readable origin (e.g. "Skalex config", "transaction options").
 */
export function validateDeferredEffectErrors(value, source) {
  if (value === undefined) return;
  if (!DEFERRED_EFFECT_STRATEGIES.includes(value)) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_DEFERRED_EFFECT_ERRORS",
      `Invalid deferredEffectErrors in ${source}: "${value}". Expected one of: ${DEFERRED_EFFECT_STRATEGIES.join(", ")}.`,
      { value, source }
    );
  }
}

class TransactionManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.abortedIdWindow=1000] - Max number of aborted transaction
   *   IDs retained for stale-continuation detection. Because transactions are
   *   serialised via a promise-chain lock, no live transaction can reference an
   *   ID more than this many steps behind the counter, so older IDs are pruned.
   */
  constructor({ abortedIdWindow = DEFAULT_ABORTED_ID_WINDOW } = {}) {
    this._txLock = Promise.resolve();
    /** @type {TransactionContext|null} Current active transaction context. */
    this._ctx = null;
    /** @type {Set<number>} IDs of aborted transactions - stale continuations checked against this. */
    this._abortedIds = new Set();
    /** @type {number} Monotonic per-instance transaction ID counter. */
    this._idCounter = 0;
    /** @type {number} Pruning window for _abortedIds. */
    this._abortedIdWindow = abortedIdWindow;
  }

  get [Symbol.toStringTag]() { return "TransactionManager"; }

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
   * @param {"throw"|"warn"|"ignore"} [opts.deferredEffectErrors]
   *   Override the Skalex-instance default for this transaction only. See
   *   `SkalexConfig.deferredEffectErrors`. When omitted, falls back to
   *   `db._deferredEffectErrors` then to `"warn"`.
   * @returns {Promise<any>}
   */
  // eslint-disable-next-line require-await -- async wraps synchronous validation throws as promise rejections.
  async run(fn, db, { timeout = 0, deferredEffectErrors } = {}) {
    validateDeferredEffectErrors(deferredEffectErrors, "transaction() options");
    const execute = async () => {
      await db._ensureConnected();

      // Track which collections existed before the transaction
      const preExisting = new Set(Object.keys(db.collections));

      const ctx = {
        id: ++this._idCounter,
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
      const timeoutPromise = timeout > 0
        ? new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            ctx.aborted = true;
            reject(new TransactionError(
              "ERR_SKALEX_TX_TIMEOUT",
              `Transaction ${ctx.id} timed out after ${timeout}ms`
            ));
          }, timeout);
        })
        : null;

      // Proxy to intercept direct collections access and brand with txId.
      // useCollection calls through the proxy stamp the returned Collection
      // with _activeTxId so pipeline/collection can distinguish transactional
      // from non-transactional writes. Liveness check prevents stale proxy use.
      const self = this;
      const proxy = new Proxy(db, {
        get(target, prop) {
          if (prop === "_txId") return ctx.id;
          if (ctx !== self._ctx) {
            throw new TransactionError(
              "ERR_SKALEX_TX_STALE_PROXY",
              `Transaction ${ctx.id} has ended. This proxy is no longer usable.`
            );
          }
          if (prop === "collections") throw new TransactionError(
            "ERR_SKALEX_TX_DIRECT_ACCESS",
            "Direct access to db.collections inside transaction() is not covered by rollback. Use the collection API (db.useCollection) instead."
          );
          if (prop === "useCollection") {
            return (name) => {
              const col = target.useCollection(name);
              col._activeTxId = ctx.id;
              // Return a Proxy of the Collection that marks each method
              // call as originating from the tx proxy. This lets the
              // pipeline distinguish tx writes from non-tx writes on the
              // same shared Collection instance.
              // Wrap the Collection in a Proxy that increments a depth
              // counter on mutation methods only. The pipeline checks this
              // counter to distinguish tx-proxy writes from non-tx writes
              // on the same shared Collection singleton.
              //
              // Only mutation methods are wrapped because reads (find,
              // findOne, count, etc.) do not go through the pipeline and
              // should not elevate the counter. If reads were wrapped, a
              // plugin-triggered non-tx write during a tx-proxy find()
              // would bypass the collection lock.
              return new Proxy(col, {
                get(colTarget, colProp) {
                  const v = Reflect.get(colTarget, colProp);
                  if (typeof v !== "function") return v;
                  if (!_MUTATION_METHODS.has(colProp)) return v.bind(colTarget);
                  return function (...args) {
                    colTarget._txProxyCallDepth = (colTarget._txProxyCallDepth || 0) + 1;
                    try {
                      const result = v.apply(colTarget, args);
                      if (result && typeof result.then === "function") {
                        return result.finally(() => { colTarget._txProxyCallDepth--; });
                      }
                      colTarget._txProxyCallDepth--;
                      return result;
                    } catch (e) {
                      colTarget._txProxyCallDepth--;
                      throw e;
                    }
                  };
                },
              });
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      /** Set after saveAtomic() succeeds. Errors after this point must NOT trigger rollback. */
      let committed = false;
      /** Result of fn(), captured so we can return it after post-commit work. */
      let result;
      /** Populated by the post-commit deferred-effect flush. */
      const deferredErrors = [];
      try {
        const fnPromise = fn(proxy);
        result = timeoutPromise
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
        committed = true;

        // Flush deferred side effects after successful commit. All effects
        // run regardless of individual failures; the configured error
        // strategy decides what happens to captured errors afterwards.
        for (const effect of ctx.deferredEffects) {
          try {
            await effect();
          } catch (effectError) {
            deferredErrors.push(effectError);
          }
        }
      } catch (error) {
        // Errors during fn() or saveAtomic() trigger rollback.
        if (committed) {
          // Shouldn't happen - all post-commit work is outside this try.
          throw error;
        }
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
            if (db._registry?._statsCache) db._registry._statsCache.delete(name);
          }
        }
        // Clear stats cache for rolled-back collections so stale sizes
        // don't survive the rollback.
        for (const name of ctx.touchedCollections) {
          if (db._registry?._statsCache) db._registry._statsCache.delete(name);
        }

        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        // Always clear context. Stale async continuations are caught by
        // assertNotAborted() via _abortedIds, not by leaving _ctx set.
        if (ctx.aborted) this._abortedIds.add(ctx.id);
        this._ctx = null;
        this._pruneAbortedIds();

        // Clear tx stamps on any cached Collection instances so they are
        // not permanently poisoned after the transaction ends.
        for (const name in db._collectionInstances) {
          const inst = db._collectionInstances[name];
          if (inst._createdInTxId === ctx.id) inst._createdInTxId = null;
          if (inst._activeTxId === ctx.id) inst._activeTxId = null;
        }
      }

      // Post-commit: handle deferred effect errors according to strategy.
      // Runs only if we reached commit; rollback paths skip this.
      if (deferredErrors.length > 0) {
        // Precedence: per-transaction option → Skalex instance default → "warn".
        const strategy = deferredEffectErrors ?? db._deferredEffectErrors ?? "warn";
        if (strategy === "throw") {
          throw new AggregateError(
            deferredErrors,
            `Deferred effect failures after commit of transaction ${ctx.id} (${deferredErrors.length})`
          );
        }
        if (strategy === "warn") {
          for (const e of deferredErrors) {
            db._logger(`[tx ${ctx.id}] deferred effect failed: ${e.message}`, "warn");
          }
        }
        // "ignore" - swallow silently
      }

      return result;
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
   * Check whether a collection is currently locked by an active transaction.
   * A collection is locked from the moment it receives its first transactional
   * write (snapshotIfNeeded) until the transaction commits or rolls back.
   *
   * @param {string} name - Collection name.
   * @returns {boolean}
   */
  isCollectionLocked(name) {
    const ctx = this._ctx;
    return ctx !== null && !ctx.aborted && ctx.touchedCollections.has(name);
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
   * Prune aborted transaction IDs that can no longer produce stale continuations.
   * Transactions are serialised, so any ID below `counter - abortedIdWindow`
   * is unreachable from the currently live transaction.
   */
  _pruneAbortedIds() {
    if (this._abortedIds.size === 0) return;
    const cutoff = this._idCounter - this._abortedIdWindow;
    if (cutoff <= 0) return;
    for (const id of this._abortedIds) {
      if (id <= cutoff) this._abortedIds.delete(id);
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
