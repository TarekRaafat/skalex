/**
 * vector.js — cosine similarity and vector utilities.
 *
 * Vectors are stored inline on documents as `_vector: number[]`.
 * They are stripped from all query results automatically.
 */

/**
 * Compute cosine similarity between two numeric vectors.
 * Returns a value in [-1, 1]; 1 = identical direction, 0 = orthogonal.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0, magA = 0, magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Return a shallow copy of a document with `_vector` removed.
 * Used by all query methods so callers never see the raw vector.
 * @param {object} doc
 * @returns {object}
 */
function stripVector(doc) {
  const copy = { ...doc };
  delete copy._vector;
  return copy;
}

module.exports = { cosineSimilarity, stripVector };
