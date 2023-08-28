/**
 * Generates a unique ID.
 * @returns {string} The unique ID.
 */
function generateUniqueId() {
  // Get the current timestamp in milliseconds.
  const timestamp = Date.now();

  // Generate a random number between 0 and 8999999999.
  const randomPart = Math.floor(Math.random() * 9000000000);

  // Combine the timestamp and random number to form the ObjectId.
  const objectId = `${timestamp}${randomPart.toString().padStart(12, "0")}`;

  // Return the first 24 characters of the ObjectId.
  return objectId.substring(0, 24);
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
