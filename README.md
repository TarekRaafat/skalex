<img src="./docs/imgs/skalex_logo.png" alt= "skalex Logo" id="logo">

<br>

# Skalex

[![GitHub package.json version](https://img.shields.io/github/package-json/v/TarekRaafat/skalex)](https://github.com/TarekRaafat/skalex)
[![npm](https://img.shields.io/npm/v/skalex)](https://www.npmjs.com/package/skalex)
![100% Javascript](https://img.shields.io/github/languages/top/TarekRaafat/skalex?color=yellow)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue.svg)
![Yes Maintained](https://img.shields.io/badge/Maintained%3F-yes-success)
[![npm](https://img.shields.io/npm/dm/skalex?label=npm)](https://www.npmjs.com/package/skalex)
[![Open Source Love](https://badges.frapsoft.com/os/v1/open-source.svg?v=103)](https://github.com/TarekRaafat/skalex)

## Introduction

The `Skalex` Library provides a simple and intuitive way to manage collections of data in a database-like manner in pure vanilla JavaScript. It allows you to create collections, insert and retrieve data, update and delete documents, and perform queries on the data in a simple yet highly flexible way to scale any application quickly and easily, while customizing your data according to your specific needs.

## Installation

To use the `Skalex` library, you need to have Node.js installed on your machine. Then, follow these steps:

1. Create a new directory for your project.
2. Open a terminal and navigate to the project directory.
3. Initialize a new Node.js project by running the following command:
   ```
   npm init -y
   ```
4. Install the `Skalex` library by running the following command:
   ```
   npm install skalex
   ```

## Getting Started

To start using the `Skalex` library, you need to require it in your JavaScript file. Here's an example:

```javascript
const Skalex = require("skalex");
```

## Class: Skalex

The `Skalex` class represents the main database instance. It provides methods for connecting to and disconnecting from the database, as well as creating and accessing collections.

### Constructor: Skalex(dataDirectory)

- `dataDirectory` (string): The directory where the database files will be stored.

Creates a new instance of the `Skalex` database.

#### Example

```javascript
const db = new Skalex("./data");
```

### Methods

#### connect()

Connects to the database and loads the existing data.

**Returns**: Promise&lt;void&gt;

#### disconnect()

Disconnects from the database and saves the data.

**Returns**: Promise&lt;void&gt;

#### useCollection(collectionName)

- `collectionName` (string): The name of the collection to use.

Retrieves the specified collection from the database. If the collection doesn't exist, it will be created.

**Returns**: Collection

#### createCollection(collectionName)

- `collectionName` (string): The name of the collection to create.

Creates a new collection with the specified name.

**Returns**: Collection

#### saveData()

Saves the data from memory to the database files.

**Returns**: Promise&lt;void&gt;

### Class: Collection

The `Collection` class represents a collection of documents in the `Skalex` database. It provides methods for inserting, updating, deleting, and querying documents in the collection.

#### Constructor: Collection()

Creates a new instance of the Collection.

#### Methods

#### insertOne(item)

- `item` (object): The document to insert.

Inserts a single document into the collection.

**Returns**: object

- `data` (object): The inserted document.
- `save()` (function): Saves the collection data to the database.

#### insertMany(items)

- `items` (array): An array of documents to insert.

Inserts multiple documents into the collection.

**Returns**: object

- `data` (array): The inserted documents.
- `save()` (function): Saves the collection data to the database.

#### updateOne(filter, update)

- `filter` (object): The filter for finding the document to update.
- `update` (object): The fields and values to update in the document.

Updates a single document in the collection that matches the filter.

**Returns**: object or null

- `data` (object): The updated document, or null if no document was found.
- `save()` (function): Saves the collection data to the database.

#### updateMany(filter, update)

- `filter` (object): The filter for finding the documents to update.
- `update` (object): The fields and values to update in the documents.

Updates multiple documents in the collection that match the filter.

**Returns**: object or array

- `data` (object or array): The updated documents, or an empty array if no documents were found.
- `save()` (function): Saves the collection data to the database.

#### findOne(filter)

- `filter` (object): The filter for finding the document.

Finds and returns a single document from the collection that matches the filter.

**Returns**: object or null

#### find(filter, options)

- `filter` (object): The filter for finding the documents.
- `options` (object, optional): Additional options for the query.
  - `populate` (array): An array of field names to populate with related data.
  - `select` (array): An array of field names to select from the documents.

Finds and returns documents from the collection that match the filter.

**Returns**: array

#### deleteOne(filter)

- `filter` (object): The filter for finding the document to delete.

Deletes a single document from the collection that matches the filter.

**Returns**: object or null

- `data` (object): The deleted document, or null if no document was found.
- `save()` (function): Saves the collection data to the database.

#### deleteMany(filter)

- `filter` (object): The filter for finding the documents to delete.

Deletes multiple documents from the collection that match the filter.

**Returns**: object

- `data` (array): The deleted documents.
- `save()` (function): Saves the collection data to the database.

#### exportToCSV(filter)

- `filter` (object, optional): The filter for exporting specific documents to CSV.

Exports the documents from the collection that match the filter to a CSV file.

**Throws**: Error if no matching data is found.

## Utility Function: generateUniqueId()

Generates a unique ID string.

**Returns**: string

This documentation provides an overview of the `Skalex` Library and its main features. For more detailed information on each method and its usage, please refer to the code comments and examples provided in the library documentation.

## Usage Examples

### 1- Basic operations

The below are examples showcasing the usage of create, insert, update, delete options in the `Skalex` Library:

```javascript
const Skalex = require("skalex");

// Create a new instance of the Skalex database
const db = new Skalex("./data");

// Connect to the database and load existing data
await db.connect();

// Create a new collection or use an existing one
const collection = db.useCollection("users");

// Insert a document into the collection
const insertedDocument = collection.insertOne({
  name: "John Doe",
  age: 30,
});

console.log("Inserted document:", insertedDocument.data);

// Update a document in the collection
const updatedDocument = collection.updateOne({ name: "John Doe" }, { age: 31 });

console.log("Updated document:", updatedDocument.data);

// Find documents in the collection
const filteredDocuments = collection.find({ age: { $gte: 30 } });

console.log("Filtered documents:", filteredDocuments);

// Delete a document from the collection
const deletedDocument = collection.deleteOne({ name: "John Doe" });

console.log("Deleted document:", deletedDocument.data);

// Disconnect from the database and save data
await db.disconnect();
```

> Please note that these are just basic examples to illustrate the usage of the `Skalex` library. You can explore and utilize the various methods and options provided by the `Skalex` to suit your specific use case and data management requirements.

### 2- Advanced operations

The below are examples showcasing the usage of population and projection options in the `Skalex` Library:

```javascript
const Skalex = require("skalex");

// Create a new instance of the Skalex database
const db = new Skalex("./data");

// Connect to the database and load existing data
await db.connect();

// Create a new collection or use an existing one
const users = db.useCollection("users");
const posts = db.useCollection("posts");

// Insert a document into the users collection
const insertedUser = users.insertOne({
  name: "John Doe",
  age: 30,
});

console.log("Inserted user:", insertedUser.data);

// Insert documents into the posts collection
const insertedPosts = posts.insertMany([
  { title: "Post 1", userId: insertedUser.data._id },
  { title: "Post 2", userId: insertedUser.data._id },
]);

console.log("Inserted posts:", insertedPosts.data);

// Find user's posts with populated user information
const userPosts = posts.find(
  { userId: insertedUser.data._id },
  { populate: ["userId"], select: ["title"] }
);

console.log("User's posts:", userPosts);

// Find user's posts with projection (selecting specific fields)
const userPostsProjection = posts.find(
  { userId: insertedUser.data._id },
  { select: ["title"] }
);

console.log("User's posts with projection:", userPostsProjection);

// Disconnect from the database and save data
await db.disconnect();
```

In the above example, we have two collections: "users" and "posts". After inserting a user document into the "users" collection, we insert two post documents into the "posts" collection, associating them with the user through the "userId" field.

To demonstrate the population feature, we use the `populate` option when finding the user's posts. This option allows us to retrieve related information from the "users" collection and populate the "userId" field with the corresponding user document. In this example, we populate the "userId" field with the user information.

Additionally, we showcase the usage of the projection feature with the `select` option. By specifying the `select` array, we can choose to retrieve only specific fields from the documents. In the second `find` operation, we select only the "title" field from the user's posts.

# Todo

- [x] Documentation
- [x] Add `createdAt` and `updatedAt`
- [x] Data projection
- [x] Data population
- [ ] Add Release notes
- [ ] Table-based option
- [ ] Remote db access
- [ ] Automated backup
- [ ] Filtering by `REGEX`
- [ ] Improve error handling
- [ ] Surgical saving process
- [ ] Auto Saving threshold
- [ ] Enhance Memory usage
- [ ] Improve index search utilize `Map`
