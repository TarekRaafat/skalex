/**
 * Generates a unique ID.
 * @returns {string} The unique ID.
 */
function generateUniqueId() {
  const timestamp = Date.now().toString(16);

  let random;
  try {
    const { randomBytes } = require('crypto');
    random = randomBytes(8).toString('hex');
  } catch {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    random = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  return `${timestamp}${random}`.substring(0, 24);
}

/**
 * Logs message to the console, with an optional type parameter to specify the log level.
 * @param msg - Represents the message to log.
 * @param type - Specifies the type of message. It can be either "error" or any other value.
 */
function logger(error, type) {
  const msg = error instanceof Error ? error.message : error;

  if (type === "error") {
    console.error(msg);
  } else {
    console.log(msg);
  }
}

module.exports = { generateUniqueId, logger };
