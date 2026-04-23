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
   * @param {Function} opts.mutate      - async (assertTxAlive) => { docs, prevDocs }
   * @param {Function} [opts.afterHookPayload] - (docs) => payload for after hook.
   * @param {boolean|undefined} opts.save
   * @param {string|undefined}  opts.session
   * @returns {Promise<{ docs: object[], prevDocs: (object|null)[] }>}
   */
  async execute({ op, beforeHook, afterHook, hookPayload, mutate, afterHookPayload, save, session }) {
    const ctx = this._ctx;

    await ctx.ensureConnected();

    // Block non-transactional writes to collections locked by an active tx.
    // Must run BEFORE _txSnapshotIfNeeded() because the snapshot would add
    // this collection to touchedCollections even for a non-tx write (since
    // _activeTxId is set on the shared Collection singleton).
    // The tx proxy wraps each method call to increment _txProxyCallDepth for
    // the duration of the call (depth counter, not boolean, to handle
    // concurrent unawaited calls on the same Collection instance). Reads are
    // unaffected (they don't go through the pipeline).
    const txm = ctx.txManager;
    if (!(this._col._txProxyCallDepth > 0) && txm.isCollectionLocked(this._col.name)) {
      throw new TransactionError(
        "ERR_SKALEX_TX_COLLECTION_LOCKED",
        `Collection "${this._col.name}" is locked by an active transaction. ` +
        `Non-transactional writes are blocked until the transaction commits or rolls back.`
      );
    }

    this._col._txSnapshotIfNeeded();

    // Determine if this mutation is part of the active transaction.
    // Collections obtained through the tx proxy have _activeTxId stamped.
    // Only those writes participate in snapshot/rollback.
    const isTxWrite = txm.active && this._col._activeTxId === txm.context?.id;

    // Detect stale continuations from aborted transactions.
    // Two sources of tx affinity:
    //   1. entryTxId: the tx active when this execute() call started
    //   2. _createdInTxId: the tx active when this Collection instance was created
    // Either being in the aborted set means this mutation must be rejected.
    const entryTxId = isTxWrite ? txm.context.id : null;
    const collTxId = this._col._createdInTxId;

    /** Guard callable passed into mutate() - must be called immediately
     *  before the first in-memory state change (push to _data, index.set, etc.). */
    const assertTxAlive = () => {
      if (entryTxId !== null && txm._abortedIds.has(entryTxId)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_ABORTED",
          `Transaction ${entryTxId} was aborted. No further mutations allowed.`
        );
      }
      if (collTxId !== null && txm._abortedIds.has(collTxId)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_ABORTED",
          `Transaction ${collTxId} was aborted. Collection obtained inside that transaction cannot be used for further mutations.`
        );
      }
    };

    // Eager check before any work (only for tx-affiliated writes)
    if (isTxWrite || collTxId !== null) assertTxAlive();

    if (beforeHook) await ctx.plugins.run(beforeHook, hookPayload);

    const { docs, prevDocs = [] } = await mutate(assertTxAlive);

    // Mark collection dirty so saveDirty() knows it needs persistence
    ctx.persistence.markDirty(ctx.collections, this._col.name);

    await this._col._saveIfNeeded(save);

    // Changelog
    if (this._col._changelogEnabled) {
      for (let i = 0; i < docs.length; i++) {
        await ctx.logChange(op, this._col.name, docs[i], prevDocs[i] ?? null, session || null);
      }
    }

    // Session stats - deferred for tx writes so rolled-back writes don't count.
    // Non-tx writes record immediately even during an active transaction.
    if (!isTxWrite || !txm.defer(() => ctx.sessionStats.recordWrite(session))) {
      ctx.sessionStats.recordWrite(session);
    }

    // Events
    for (const doc of docs) {
      ctx.emitEvent(this._col.name, { op, collection: this._col.name, doc: stripVector(doc) });
    }

    // After hook - fire per-doc for insert, single call for update/delete.
    // All hook payloads receive vector-stripped docs for consistency, so
    // plugins don't have to handle _vector presence vs absence per hook type.
    if (afterHook) {
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
    const ctx = this._ctx;

    await ctx.ensureConnected();

    const txm = ctx.txManager;
    if (!(this._col._txProxyCallDepth > 0) && txm.isCollectionLocked(this._col.name)) {
      throw new TransactionError(
        "ERR_SKALEX_TX_COLLECTION_LOCKED",
        `Collection "${this._col.name}" is locked by an active transaction. ` +
        `Non-transactional writes are blocked until the transaction commits or rolls back.`
      );
    }

    this._col._txSnapshotIfNeeded();

    const isTxWrite = txm.active && this._col._activeTxId === txm.context?.id;
    const entryTxId = isTxWrite ? txm.context.id : null;
    const collTxId = this._col._createdInTxId;

    const assertTxAlive = () => {
      if (entryTxId !== null && txm._abortedIds.has(entryTxId)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_ABORTED",
          `Transaction ${entryTxId} was aborted. No further mutations allowed.`
        );
      }
      if (collTxId !== null && txm._abortedIds.has(collTxId)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_ABORTED",
          `Transaction ${collTxId} was aborted. Collection obtained inside that transaction cannot be used for further mutations.`
        );
      }
    };

    if (isTxWrite || collTxId !== null) assertTxAlive();

    const result = await mutateBatch(assertTxAlive);
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

    if (!isTxWrite || !txm.defer(() => ctx.sessionStats.recordWrite(session))) {
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
