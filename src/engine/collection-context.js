/**
 * collection-context.js - CollectionContext shape and test factory.
 *
 * The CollectionContext is the narrow dependency surface between Collection
 * and the rest of the Skalex engine. It replaces the direct Skalex reference
 * that Collection used to hold.
 *
 * This module documents the required shape and provides a `forTesting()`
 * factory that creates a minimal context with sensible defaults, so
 * Collection can be instantiated in tests without a full Skalex instance.
 */

import EventBus from "../features/events.js";
import PluginEngine from "../features/plugins.js";
import SessionStats from "../features/session-stats.js";

/**
 * Create a minimal CollectionContext for isolated testing.
 *
 * Every property has a sensible default. Callers can override any property
 * by passing it in the `overrides` object.
 *
 * @param {Partial<CollectionContext>} [overrides]
 * @returns {CollectionContext}
 *
 * @example
 * const ctx = CollectionContext.forTesting({ autoSave: true });
 * const col = new Collection(store, ctx);
 * await col.insertOne({ name: "test" });
 */
function forTesting(overrides = {}) {
  const eventBus = new EventBus();
  const plugins = new PluginEngine();
  const sessionStats = new SessionStats();
  const txManager = {
    active: false,
    context: null,
    defer: () => false,
    snapshotIfNeeded: () => {},
    assertNotAborted: () => {},
    isCollectionLocked: () => false,
    _abortedIds: new Set(),
  };

  const defaults = {
    ensureConnected: async () => {},
    txManager,
    plugins,
    eventBus,
    sessionStats,
    queryLog: null,
    logger: () => {},
    persistence: {
      markDirty: () => {},
      save: async () => {},
      saveAtomic: async () => {},
    },
    collections: {},
    embed: async () => [],
    idGenerator: null,
    autoSave: false,
    saveCollection: async () => {},
    snapshotCollection: (col) => ({ data: structuredClone(col.data) }),
    getCollection: () => null,
    emitEvent: (name, data) => eventBus.emit(name, data),
    runAfterHook: async (hook, data) => plugins.run(hook, data),
    logChange: async () => {},
    fs: null,
    dataDirectory: "./.test-db",
  };

  return { ...defaults, ...overrides };
}

export { forTesting };
