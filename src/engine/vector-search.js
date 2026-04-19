import { cosineSimilarity, stripVector } from "./vector.js";

/**
 * Semantic similarity search - embed a query string and rank all candidate
 * documents by cosine similarity.
 *
 * @param {string} query - Natural-language query text.
 * @param {object[]} candidates - Pre-filtered document list.
 * @param {Function} embedFn - async (text) => number[].
 * @param {{ limit?: number, minScore?: number }} opts
 * @returns {Promise<{ docs: object[], scores: number[] }>}
 */
async function vectorSearch(query, candidates, embedFn, { limit = 10, minScore = 0 } = {}) {
  const queryVector = await embedFn(query);

  const scored = [];
  for (const doc of candidates) {
    if (!doc._vector) continue;
    const score = cosineSimilarity(queryVector, doc._vector);
    if (score >= minScore) scored.push({ doc, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  return {
    docs: top.map(r => stripVector(r.doc)),
    scores: top.map(r => r.score),
  };
}

/**
 * Find the nearest neighbours to an existing document by its vector.
 *
 * @param {number[]} sourceVector - The source document's vector.
 * @param {string} sourceId - The source document's _id (excluded from results).
 * @param {object[]} data - Full data array.
 * @param {{ limit?: number, minScore?: number }} opts
 * @returns {{ docs: object[], scores: number[] }}
 */
function similarByVector(sourceVector, sourceId, data, { limit = 10, minScore = 0 } = {}) {
  const scored = [];
  for (const doc of data) {
    if (doc._id === sourceId || !doc._vector) continue;
    const score = cosineSimilarity(sourceVector, doc._vector);
    if (score >= minScore) scored.push({ doc, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  return {
    docs: top.map(r => stripVector(r.doc)),
    scores: top.map(r => r.score),
  };
}

export { vectorSearch, similarByVector };
