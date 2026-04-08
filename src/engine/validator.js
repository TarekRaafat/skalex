/**
 * validator.js  -  lightweight schema validation, zero dependencies.
 *
 * Schema definition:
 *   { field: "type" }
 *   { field: { type: "string", required: true, unique: true, enum: [...] } }
 *
 * Supported types: "string", "number", "boolean", "object", "array", "date", "any"
 */

import { ValidationError } from "./errors.js";

const SUPPORTED_TYPES = new Set(["string", "number", "boolean", "object", "array", "date", "any"]);

/**
 * Determine the runtime type of a value using the schema type vocabulary.
 * @param {*} val
 * @returns {string}
 */
function typeOf(val) {
  if (Array.isArray(val)) return "array";
  if (val instanceof Date) return "date";
  return typeof val;
}

/**
 * Parse a raw schema definition into a normalised internal form.
 * @param {object} schema
 * @returns {{ fields: Map<string, FieldDef>, uniqueFields: string[] }}
 */
function parseSchema(schema) {
  const fields = new Map();
  const uniqueFields = [];

  for (const [key, def] of Object.entries(schema)) {
    let fieldDef;

    if (typeof def === "string") {
      if (!SUPPORTED_TYPES.has(def)) {
        throw new ValidationError("ERR_SKALEX_VALIDATION_UNKNOWN_TYPE", `Unknown schema type "${def}" for field "${key}"`, { field: key, type: def });
      }
      fieldDef = { type: def, required: false, unique: false };
    } else if (typeof def === "object" && def !== null) {
      const { type = "any", required = false, unique = false, enum: enumVals } = def;
      if (!SUPPORTED_TYPES.has(type)) {
        throw new ValidationError("ERR_SKALEX_VALIDATION_UNKNOWN_TYPE", `Unknown schema type "${type}" for field "${key}"`, { field: key, type });
      }
      fieldDef = { type, required, unique, enum: enumVals };
      if (unique) uniqueFields.push(key);
    } else {
      throw new ValidationError("ERR_SKALEX_VALIDATION_INVALID_SCHEMA", `Invalid schema definition for field "${key}"`, { field: key });
    }

    fields.set(key, fieldDef);
  }

  return { fields, uniqueFields };
}

/**
 * Validate a document against a parsed schema.
 * Returns an array of error strings (empty = valid).
 * @param {object} doc
 * @param {Map<string, object>} fields
 * @param {boolean} [strict=false] - Reject unknown fields not declared in the schema.
 * @returns {string[]}
 */
function validateDoc(doc, fields, strict = false) {
  const errors = [];

  for (const [key, def] of fields) {
    const val = doc[key];
    const missing = val === undefined || val === null;

    if (def.required && missing) {
      errors.push(`Field "${key}" is required`);
      continue;
    }

    if (missing) continue;

    if (def.type !== "any") {
      const actualType = typeOf(val);
      if (actualType !== def.type) {
        errors.push(`Field "${key}" must be of type "${def.type}", got "${actualType}"`);
      }
    }

    if (def.enum && !def.enum.includes(val)) {
      errors.push(`Field "${key}" must be one of [${def.enum.map(v => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(val)}`);
    }
  }

  if (strict) {
    for (const key of Object.keys(doc)) {
      if (!key.startsWith("_") && !fields.has(key)) {
        errors.push(`Unknown field "${key}" (strict mode)`);
      }
    }
  }

  return errors;
}

/**
 * Strip fields that are unknown to the schema or fail type/enum validation.
 * Preserves all internal fields (prefixed with "_").
 * @param {object} doc
 * @param {Map<string, object>} fields
 * @returns {object}
 */
function stripInvalidFields(doc, fields) {
  const out = {};
  for (const [key, val] of Object.entries(doc)) {
    if (key.startsWith("_")) { out[key] = val; continue; }
    if (!fields.has(key)) continue;
    const def = fields.get(key);
    if (def.type !== "any") {
      const actualType = typeOf(val);
      if (actualType !== def.type) continue;
    }
    if (def.enum && !def.enum.includes(val)) continue;
    out[key] = val;
  }
  return out;
}

/**
 * Infer a simple schema from a sample document.
 * @param {object} doc
 * @returns {object}
 */
function inferSchema(doc) {
  const schema = {};
  for (const [key, val] of Object.entries(doc)) {
    if (key.startsWith("_")) continue; // skip internal fields
    const t = typeOf(val);
    schema[key] = SUPPORTED_TYPES.has(t) ? t : "any";
  }
  return schema;
}

export { parseSchema, validateDoc, inferSchema, stripInvalidFields };
