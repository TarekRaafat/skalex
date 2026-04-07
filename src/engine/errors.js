/**
 * errors.js  -  typed error hierarchy for the Skalex engine.
 *
 * Every engine throw uses a typed error with a stable code so consumers
 * can handle errors programmatically without parsing message strings.
 *
 * Code convention:  ERR_SKALEX_<SUBSYSTEM>_<SPECIFIC>
 */

/**
 * Base error for all Skalex engine errors.
 * @extends Error
 */
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

export {
  SkalexError,
  ValidationError,
  UniqueConstraintError,
  TransactionError,
  PersistenceError,
  AdapterError,
  QueryError,
};
