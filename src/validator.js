/**
 * validator.js — lightweight schema validation, zero dependencies.
 *
 * Schema definition:
 *   { field: "type" }
 *   { field: { type: "string", required: true, unique: true, enum: [...] } }
 *
 * Supported types: "string", "number", "boolean", "object", "array", "date", "any"
 */

const SUPPORTED_TYPES = new Set(["string", "number", "boolean", "object", "array", "date", "any"]);

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
        throw new Error(`Unknown schema type "${def}" for field "${key}"`);
      }
      fieldDef = { type: def, required: false, unique: false };
    } else if (typeof def === "object" && def !== null) {
      const { type = "any", required = false, unique = false, enum: enumVals } = def;
      if (!SUPPORTED_TYPES.has(type)) {
        throw new Error(`Unknown schema type "${type}" for field "${key}"`);
      }
      fieldDef = { type, required, unique, enum: enumVals };
      if (unique) uniqueFields.push(key);
    } else {
      throw new Error(`Invalid schema definition for field "${key}"`);
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
 * @returns {string[]}
 */
function validateDoc(doc, fields) {
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
      const actualType = Array.isArray(val) ? "array" : (val instanceof Date ? "date" : typeof val);
      if (actualType !== def.type) {
        errors.push(`Field "${key}" must be of type "${def.type}", got "${actualType}"`);
      }
    }

    if (def.enum && !def.enum.includes(val)) {
      errors.push(`Field "${key}" must be one of [${def.enum.map(v => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(val)}`);
    }
  }

  return errors;
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
    const t = Array.isArray(val) ? "array" : (val instanceof Date ? "date" : typeof val);
    schema[key] = SUPPORTED_TYPES.has(t) ? t : "any";
  }
  return schema;
}

module.exports = { parseSchema, validateDoc, inferSchema };
