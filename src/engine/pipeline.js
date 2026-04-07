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
   * @param {object} opts
   * @param {string}   opts.op          - "insert" | "update" | "delete" | "restore"
   * @param {string}   opts.beforeHook  - Plugin hook name (e.g. "beforeInsert")
   * @param {string}   opts.afterHook   - Plugin hook name (e.g. "afterInsert")
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
    this._col._txSnapshotIfNeeded();

    // Detect stale continuations from aborted transactions.
    // Two sources of tx affinity:
    //   1. entryTxId: the tx active when this execute() call started
    //   2. _createdInTxId: the tx active when this Collection instance was created
    // Either being in the aborted set means this mutation must be rejected.
    const txm = ctx.txManager;
    const entryTxId = txm.context?.id ?? null;
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

    // Eager check before any work
    assertTxAlive();

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

    // Session stats - deferred inside transactions so rolled-back writes don't count
    if (!txm.defer(() => ctx.sessionStats.recordWrite(session))) {
      ctx.sessionStats.recordWrite(session);
    }

    // Events
    for (const doc of docs) {
      ctx.emitEvent(this._col.name, { op, collection: this._col.name, doc: stripVector(doc) });
    }

    // After hook - fire per-doc for insert, single call for update/delete
    if (afterHook) {
      if (afterHookPayload) {
        await ctx.runAfterHook(afterHook, afterHookPayload(docs));
      } else {
        for (const doc of docs) {
          await ctx.runAfterHook(afterHook, { collection: this._col.name, doc: stripVector(doc) });
        }
      }
    }

    return { docs, prevDocs };
  }
}

export default MutationPipeline;
