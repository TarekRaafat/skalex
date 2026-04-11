/**
 * constants.js  -  Shared engine constants.
 *
 * Operation and hook names used across the mutation pipeline, changelog,
 * events, and plugin APIs. Centralised here so there is exactly one source
 * of truth and typos become compile-time surface rather than silent bugs.
 */

export const Ops = Object.freeze({
  INSERT: "insert",
  UPDATE: "update",
  DELETE: "delete",
  RESTORE: "restore",
});

export const Hooks = Object.freeze({
  BEFORE_INSERT: "beforeInsert",
  AFTER_INSERT:  "afterInsert",
  BEFORE_UPDATE: "beforeUpdate",
  AFTER_UPDATE:  "afterUpdate",
  BEFORE_DELETE: "beforeDelete",
  AFTER_DELETE:  "afterDelete",
  BEFORE_FIND:   "beforeFind",
  AFTER_FIND:    "afterFind",
  BEFORE_SEARCH: "beforeSearch",
  AFTER_SEARCH:  "afterSearch",
});
