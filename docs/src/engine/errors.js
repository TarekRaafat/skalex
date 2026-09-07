/**
 * errors.js  -  typed error hierarchy for the Skalex engine.
 *
 * Every engine throw uses a typed error with a stable code so consumers
 * can handle errors programmatically without parsing message strings.
 *
 * Code convention:  ERR_SKALEX_<SUBSYSTEM>_<SPECIFIC>
 */

/**
 * Create the shared error hierarchy.
 * @returns {object} Named error constructors.
 */
function _createErrorTypes() {
  /** Base error for all Skalex engine errors. */
  class SkalexError extends Error {
    /**
     * @param {string} code    - Stable error code (e.g. "ERR_SKALEX_VALIDATION_REQUIRED").
     * @param {string} message - Human-readable description.
     * @param {object} [details] - Structured context for programmatic consumers.
     */
    constructor(code, message, details = {}) {
      super(message);
      this.name = this.constructor.name;
      this.code = code;
      this.details = details;
    }
  }

  /** Schema parsing or document validation failure. */
  class ValidationError extends SkalexError { }

  /** Insert or update violates a unique field constraint. */
  class UniqueConstraintError extends SkalexError { }

  /** Transaction timeout, abort, or rollback failure. */
  class TransactionError extends SkalexError { }

  /** Load, save, serialization, or flush failure. */
  class PersistenceError extends SkalexError { }

  /** Storage or AI adapter misconfiguration or missing dependency. */
  class AdapterError extends SkalexError { }

  /** Query filter, operator, or execution failure. */
  class QueryError extends SkalexError { }

  const types = { SkalexError, ValidationError, UniqueConstraintError, TransactionError, PersistenceError, AdapterError, QueryError };
  for (const [name, Type] of Object.entries(types)) Object.defineProperty(Type, "name", { value: name });
  return types;
}

// Source connectors and ESM/CJS/browser bundles share constructors in one realm.
// The versioned symbol avoids string globals and keeps type-based catches stable.
const _key = Symbol.for("skalex.errors.v4");
if (!globalThis[_key]) Object.defineProperty(globalThis, _key, { value: Object.freeze(_createErrorTypes()) });
const { SkalexError, ValidationError, UniqueConstraintError, TransactionError, PersistenceError, AdapterError, QueryError } = globalThis[_key];

export {
  SkalexError,
  ValidationError,
  UniqueConstraintError,
  TransactionError,
  PersistenceError,
  AdapterError,
  QueryError,
};
