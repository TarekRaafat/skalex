/**
 * transaction.js  -  TransactionManager for Skalex.
 *
 * Owns transaction scope, lazy snapshots, timeout/abort protection,
 * deferred side effects, and rollback.
 */
import { TransactionError, ValidationError } from "./errors.js";

/** Default window of aborted transaction IDs retained for diagnostics. */
const DEFAULT_ABORTED_ID_WINDOW = 1000;

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

// Explicit capabilities: future Collection methods are not admitted implicitly.
const _COLLECTION_METHODS = [
  "insertOne", "insertMany", "updateOne", "updateMany", "upsert", "upsertMany",
  "deleteOne", "deleteMany", "restore", "findOne", "find", "search", "similar",
  "count", "sum", "avg", "groupBy",
];

/** Build a readonly capability handle without exposing the backing object. */
function _createHandle(target, methods, assertAlive, kind, name) {
  const surface = Object.create(null);
  if (name !== undefined) surface.name = name;
  surface[Symbol.toStringTag] = kind;
  const deny = (_target, property) => {
    throw new TransactionError(
      "ERR_SKALEX_TX_DIRECT_ACCESS",
      `Direct access to ${kind === "TransactionHandle" ? "db" : "collection"}.${String(property)} inside transaction() is not supported. Use the documented transaction capabilities.`,
      { handle: kind, property: String(property) }
    );
  };
  // Resolve only used methods. Each captured function still checks lifetime.
  const resolve = property => {
    if (Object.hasOwn(surface, property)) return surface[property];
    if (!methods.includes(property)) return undefined;
    return surface[property] = (...args) => {
      assertAlive();
      return target[property](...args);
    };
  };
  return new Proxy(surface, {
    get: (object, property) => {
      // Promise assimilation and inspection must not expose extra capabilities.
      if (property === "then") return undefined;
      assertAlive();
      const value = resolve(property);
      if (value !== undefined) return value;
      if (typeof property === "symbol") return undefined;
      return deny(object, property);
    },
    has: (_object, property) => Object.hasOwn(surface, property) || methods.includes(property),
    ownKeys: () => [...methods, ...(name === undefined ? [] : ["name"]), Symbol.toStringTag],
    getOwnPropertyDescriptor: (_object, property) => {
      const value = resolve(property);
      return value === undefined ? undefined : {
        value, writable: false, enumerable: true, configurable: true,
      };
    },
    preventExtensions: () => deny(surface, "preventExtensions"),
    set: deny,
    defineProperty: deny,
    deleteProperty: deny,
    setPrototypeOf: () => deny(surface, "__proto__"),
  });
}

class TransactionManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.abortedIdWindow=1000] - Max number of aborted transaction
   *   IDs retained for diagnostics. Handle liveness uses the retained context,
   *   so pruning this bounded history cannot admit a stale continuation.
   */
  constructor({ abortedIdWindow = DEFAULT_ABORTED_ID_WINDOW } = {}) {
    this._txLock = Promise.resolve();
    /** @type {TransactionContext|null} Current active transaction context. */
    this._ctx = null;
    /** @type {Set<number>} Recent aborted transaction IDs, retained for diagnostics. */
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
   * @param {Function} fn            - (handle) => Promise<any>
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

      const ctx = {
        id: ++this._idCounter,
        startedAt: Date.now(),
        aborted: false,
        closed: false,
        committed: false,
        createdCollections: new Map(),
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

      // Transaction handles share stores, but never share ownership with the
      // ordinary cached Collection. Context travels with every owned operation.
      const handles = new Map();
      const base = db._collectionContext;
      const scoped = Object.assign(Object.create(base), {
        _transaction: ctx,
        getCollection: name => getCollection(name),
      });
      for (const method of ["emitEvent", "runAfterHook", "logChange"]) {
        scoped[method] = (...args) => { this.defer(() => base[method](...args), ctx); };
      }
      const getCollection = (name, options, create = false) => {
        this._assertOwner(ctx);
        const existing = db.collections[name];
        if (create && existing) {
          throw new TransactionError(
            "ERR_SKALEX_TX_DIRECT_ACCESS",
            "Replacing a collection definition inside transaction() is not supported. Use useCollection() to mutate its documents."
          );
        }
        const col = create ? db.createCollection(name, options) : db.useCollection(name);
        if (!existing) ctx.createdCollections.set(name, col._store);
        if (!handles.has(name)) {
          const owned = new db._registry._CollectionClass(col._store, scoped);
          handles.set(name, _createHandle(
            owned, _COLLECTION_METHODS, () => this._assertOwner(ctx),
            "TransactionCollection", name
          ));
        }
        return handles.get(name);
      };
      const handle = _createHandle({
        useCollection: name => getCollection(name),
        createCollection: (name, options) => getCollection(name, options, true),
      }, ["useCollection", "createCollection"], () => this._assertOwner(ctx), "TransactionHandle");

      /** Set after saveAtomic() succeeds. Errors after this point must NOT trigger rollback. */
      let committed = false;
      /** Result of fn(), captured so we can return it after post-commit work. */
      let result;
      /** Populated by the post-commit deferred-effect flush. */
      const deferredErrors = [];
      try {
        const fnPromise = fn(handle);
        result = timeoutPromise
          ? await Promise.race([fnPromise, timeoutPromise])
          : await fnPromise;

        if (ctx.aborted) {
          throw new TransactionError("ERR_SKALEX_TX_ABORTED", `Transaction ${ctx.id} was aborted`);
        }

        // End callback ownership before persistence begins. Late continuations
        // cannot add mutations to a commit already in progress.
        ctx.closed = true;
        if (timer) clearTimeout(timer);

        // Commit: persist only touched collections
        const touched = [...ctx.touchedCollections];
        if (touched.length > 0) {
          await db._persistence.saveAtomic(db.collections, touched);
        }
        committed = true;
        ctx.committed = true;

        // Flush deferred side effects after successful commit. All effects
        // run regardless of individual failures. The configured error
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
        ctx.aborted = true;
        // Restore only owned writes, in reverse first-touch order.
        for (const [name, snap] of [...ctx.snapshots].reverse()) {
          if (!ctx.createdCollections.has(name)) {
            db._applySnapshot(name, snap);
            // Restore the dirty flag to its pre-transaction state
            if (db.collections[name]) db.collections[name]._dirty = snap._dirty;
          }
        }
        // Independent creation belongs to its caller, even during a rollback.
        for (const [name, store] of ctx.createdCollections) {
          if (db.collections[name] === store) {
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
        // Handles retain their ended context even after diagnostic IDs expire.
        ctx.closed = true;
        if (ctx.aborted) this._abortedIds.add(ctx.id);
        this._ctx = null;
        this._pruneAbortedIds();
      }

      // Post-commit: handle deferred effect errors according to strategy.
      // Runs only if we reached commit. Rollback paths skip this.
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
    return ctx !== null && !ctx.aborted && !ctx.committed &&
      (ctx.touchedCollections.has(name) || ctx.createdCollections.has(name));
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
        `Transaction ${ctx.id} has ended because it was aborted. No further mutations allowed.`
      );
    }
  }

  /** Reject operations whose explicit transaction owner has ended. */
  _assertOwner(ctx) {
    this._assertCtxNotAborted(ctx);
    if (ctx !== this._ctx || ctx.closed) {
      throw new TransactionError(
        "ERR_SKALEX_TX_STALE_PROXY",
        `Transaction ${ctx.id} has ended. This handle is no longer usable.`
      );
    }
  }

  /**
   * Bound diagnostic history independently of handle lifetime checks.
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
   * Returns false without an owner. The caller then executes immediately.
   * @param {Function} effect - async () => void
   * @param {object} [ctx] - Explicit transaction owner.
   * @returns {boolean} true if deferred, false if the caller should execute
   */
  defer(effect, ctx) {
    if (ctx) {
      this._assertOwner(ctx);
      ctx.deferredEffects.push(effect);
      return true;
    }
    return false;
  }
}

export default TransactionManager;
