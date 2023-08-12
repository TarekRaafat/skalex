const fs = require("fs");

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
function logger(msg, type) {
  if (type === "error") {
    console.error(msg);
  } else {
    console.log(msg);
  }
}

/**
 * Checks if a directory exists, and if not, creates it.
 * @param directoryPath - String that represents the path of the directory
 */
function dirCheck(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

module.exports = { dirCheck, generateUniqueId, logger };
