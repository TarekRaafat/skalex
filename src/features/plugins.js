/**
 * PluginEngine  -  pre/post hook system for all database operations.
 *
 * Plugins are plain objects with optional async hook methods.
 * All hooks are awaited in registration order.
 *
 * Available hooks:
 *   beforeInsert(ctx)  / afterInsert(ctx)
 *   beforeUpdate(ctx)  / afterUpdate(ctx)
 *   beforeDelete(ctx)  / afterDelete(ctx)
 *   beforeFind(ctx)    / afterFind(ctx)
 *   beforeSearch(ctx)  / afterSearch(ctx)
 *
 * Context shapes:
 *   beforeInsert  : { collection, doc }
 *   afterInsert   : { collection, doc }            -  doc is the fully inserted document
 *   beforeUpdate  : { collection, filter, update }
 *   afterUpdate   : { collection, filter, update, result }
 *   beforeDelete  : { collection, filter }
 *   afterDelete   : { collection, filter, result }
 *   beforeFind    : { collection, filter, options }
 *   afterFind     : { collection, filter, options, docs }
 *   beforeSearch  : { collection, query, options }
 *   afterSearch   : { collection, query, options, docs, scores }
 *
 * @example
 * db.use({
 *   async beforeInsert({ collection, doc }) {
 *     console.log(`Inserting into ${collection}:`, doc);
 *   },
 *   async afterInsert({ collection, doc }) {
 *     await audit.log("insert", collection, doc._id);
 *   },
 * });
 */
class PluginEngine {
  constructor() {
    /** @type {object[]} */
    this._plugins = [];
  }

  /**
   * Register a plugin.
   * @param {object} plugin - An object with optional hook methods.
   */
  register(plugin) {
    if (typeof plugin !== "object" || plugin === null) {
      throw new TypeError("Plugin must be a non-null object.");
    }
    this._plugins.push(plugin);
  }

  /**
   * Run all registered handlers for a given hook name.
   * @param {string} hook - e.g. "beforeInsert"
   * @param {object} context - The context object passed to each handler.
   * @returns {Promise<void>}
   */
  async run(hook, context) {
    for (const plugin of this._plugins) {
      if (typeof plugin[hook] === "function") {
        await plugin[hook](context);
      }
    }
  }

  /**
   * Return the number of registered plugins.
   * @returns {number}
   */
  get size() {
    return this._plugins.length;
  }
}

export default PluginEngine;
