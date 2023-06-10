/**
 * Generates a unique ID.
 * @returns {string} The unique ID.
 */
function generateUniqueId() {
  // A simple implementation to generate unique IDs (not guaranteed to be globally unique)
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
}

module.exports = { generateUniqueId };
