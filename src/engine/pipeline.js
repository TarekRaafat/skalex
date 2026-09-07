/**
 * pipeline.js  -  MutationPipeline for Skalex collections.
 *
 * Extracts the shared pre/post mutation lifecycle so each CRUD method
 * only defines its operation-specific logic.
 *
 * Shared lifecycle:
 *   ensureConnected → txSnapshot → beforePlugin → [mutation] →
 *   markDirty → save → changelog → sessionStats → event → afterPlugin
 */
import { stripVector } from "./vector.js";
import { TransactionError } from "./errors.js";

class MutationPipeline {
  /**
   * @param {import("./collection.js").default} collection
   */
  constructor(collection) {
    this._col = collection;
  }

  /** @returns {CollectionContext} */
  get _ctx() { return this._col._ctx; }

  /**
   * Shared pipeline-entry sequence for `execute()` and `executeBatch()`.
   *
   * Runs, in order: `ensureConnected`, the tx-lock guard, `_txSnapshotIfNeeded`,
   * transaction-affiliation detection, and the eager abort check. Both callers
   * begin with a single `_enterPipeline()` call so this sequence has exactly one
   * definition - any change to lock semantics, snapshotting, or abort detection
   * lands in one place instead of drifting between the two methods.
   *
   * @returns {Promise<{ ctx: CollectionContext, txm: object, isTxWrite: boolean, assertTxAlive: () => void }>}
   */
  async _enterPipeline() {
    const ctx = this._ctx;

    await ctx.ensureConnected();
    if (this._col._store._recoveryError) throw this._col._store._recoveryError;

    const txm = ctx.txManager;
    const owner = ctx._transaction;
    const isTxWrite = !!owner;
    // Recheck after async preparation as well as on entry: a bare write can
    // begin before a transaction acquires the collection lock.
    const assertTxAlive = () => {
      this._ctx.assertCollection?.();
      if (owner) txm._assertOwner(owner);
      else if (txm.isCollectionLocked(this._col.name)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_COLLECTION_LOCKED",
          `Collection "${this._col.name}" is locked by an active transaction. ` +
          "Non-transactional writes are blocked until the transaction commits or rolls back."
        );
      }
    };
    assertTxAlive();
    this._col._txSnapshotIfNeeded();

    return { ctx, txm, isTxWrite, assertTxAlive };
  }

  /**
   * Execute a mutation with the full lifecycle.
   *
   * Event ordering contract
   * -----------------------
   * Watch events are emitted **before** the after-hook runs. This is
   * intentional: it keeps observers on the synchronous path of the mutation
   * and preserves strict per-collection delivery order. A consequence is
   * that observers may see a mutation event whose corresponding after-hook
   * subsequently throws - the mutation itself is already committed.
   *
   * Event dispatch is synchronous. A slow watch listener blocks the
   * mutation pipeline. Listeners should hand work off to a queue if they
   * need to do anything non-trivial.
   *
   * @param {object} opts
   * @param {string}   opts.op          - One of the `Ops` values from src/engine/constants.js.
   * @param {string}   opts.beforeHook  - One of the `Hooks` values from src/engine/constants.js (e.g. `Hooks.BEFORE_INSERT`).
   * @param {string}   opts.afterHook   - One of the `Hooks` values from src/engine/constants.js (e.g. `Hooks.AFTER_INSERT`).
   * @param {object}   opts.hookPayload - Data passed to before hook.
   * @param {Function} opts.mutate      - (assertTxAlive) => { docs, prevDocs?, emitEvents? }. The emitEvents callback overrides default watch events after saving.
   * @param {boolean} [opts.replay=false] - Suppress changelog recording for historical replay.
   * @param {Function} [opts.afterHookPayload] - (docs) => payload for after hook.
   * @param {boolean|undefined} opts.save
   * @param {string|undefined}  opts.session
   * @returns {Promise<{ docs: object[], prevDocs: (object|null)[] }>}
   */
  async execute({ op, beforeHook, afterHook, hookPayload, mutate, afterHookPayload, save, session, replay = false }) {
    const { ctx, txm, isTxWrite, assertTxAlive } = await this._enterPipeline();

    if (beforeHook) await ctx.plugins.run(beforeHook, hookPayload);

    const { docs, prevDocs = [], emitEvents } = await mutate(assertTxAlive);
    if (isTxWrite) assertTxAlive();

    // Mark collection dirty so saveDirty() knows it needs persistence
    ctx.persistence.markDirty(ctx.collections, this._col.name);

    await this._col._saveIfNeeded(save);

    // Historical replay must not append its own changes to the archive.
    if (this._col._changelogEnabled && !replay) {
      for (let i = 0; i < docs.length; i++) {
        await ctx.logChange(op, this._col.name, docs[i], prevDocs[i] ?? null, session || null);
      }
    }

    // Session stats - deferred for tx writes so rolled-back writes don't count.
    // Non-tx writes record immediately even during an active transaction.
    if (!isTxWrite || !txm.defer(() => ctx.sessionStats.recordWrite(session), ctx._transaction)) {
      ctx.sessionStats.recordWrite(session);
    }

    // Replay supplies its historical transition events after saving.
    if (emitEvents) emitEvents();
    else for (const doc of docs) {
      ctx.emitEvent(this._col.name, { op, collection: this._col.name, doc: stripVector(doc) });
    }

    // After hook - fire per-doc for insert, single call for update/delete.
    // All hook payloads receive vector-stripped docs for consistency, so
    // plugins don't have to handle _vector presence vs absence per hook type.
    // Owned writes must retain deferred hooks even if plugins register later.
    if (afterHook && (isTxWrite || ctx.plugins.size)) {
      if (afterHookPayload) {
        const stripped = docs.map(stripVector);
        await ctx.runAfterHook(afterHook, afterHookPayload(stripped));
      } else {
        for (const doc of docs) {
          await ctx.runAfterHook(afterHook, { collection: this._col.name, doc: stripVector(doc) });
        }
      }
    }

    return { docs, prevDocs };
  }

  /**
   * Batch mutation variant used by operations that resolve to a mix of
   * inserts and updates (currently `upsertMany`). Amortizes per-doc pipeline
   * overhead into a single pass:
   *
   *   - `ensureConnected`, lock check, `_txSnapshotIfNeeded`, `assertTxAlive`
   *     eager check, `markDirty`, `_saveIfNeeded`, and `sessionStats.recordWrite`
   *     all run once for the whole batch.
   *
   * Preserves per-document correctness where it matters to observers:
   *
   *   - Changelog entries are emitted per document, using the per-doc `op`
   *     string in `result.ops` when present, otherwise falling back to the
   *     batch-level `op`.
   *   - Watch events fire per document with the same op-per-doc semantics.
   *
   * Plugin hooks are NOT dispatched here. The caller is responsible for
   * firing `beforeInsert` / `beforeUpdate` inside `mutateBatch` (before the
   * in-memory state change) and `afterInsert` / `afterUpdate` after the
   * returned promise resolves, so upsertMany preserves the existing per-doc
   * hook contract that callers already rely on.
   *
   * @param {object} opts
   * @param {string}   opts.op           - Default op for changelog/events.
   * @param {Function} opts.mutateBatch  - async (assertTxAlive) => { docs: object[], prevDocs?: (object|null)[], ops?: string[] }
   * @param {boolean|undefined} opts.save
   * @param {string|undefined}  opts.session
   * @returns {Promise<{ docs: object[], prevDocs: (object|null)[], ops: string[] }>}
   */
  async executeBatch({ op, mutateBatch, save, session }) {
    const { ctx, txm, isTxWrite, assertTxAlive } = await this._enterPipeline();

    const result = await mutateBatch(assertTxAlive);
    if (isTxWrite) assertTxAlive();
    const docs = Array.isArray(result?.docs) ? result.docs : [];
    const prevDocs = Array.isArray(result?.prevDocs) ? result.prevDocs : [];
    const ops = Array.isArray(result?.ops) ? result.ops : [];

    if (docs.length === 0) {
      return { docs, prevDocs, ops };
    }

    ctx.persistence.markDirty(ctx.collections, this._col.name);
    await this._col._saveIfNeeded(save);

    if (this._col._changelogEnabled) {
      for (let i = 0; i < docs.length; i++) {
        await ctx.logChange(ops[i] || op, this._col.name, docs[i], prevDocs[i] ?? null, session || null);
      }
    }

    if (!isTxWrite || !txm.defer(() => ctx.sessionStats.recordWrite(session), ctx._transaction)) {
      ctx.sessionStats.recordWrite(session);
    }

    for (let i = 0; i < docs.length; i++) {
      ctx.emitEvent(this._col.name, {
        op: ops[i] || op,
        collection: this._col.name,
        doc: stripVector(docs[i]),
      });
    }

    return { docs, prevDocs, ops };
  }
}

export default MutationPipeline;
