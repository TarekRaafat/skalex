# Documentation <!-- {docsify-ignore} -->

---

To start using the `Skalex` library, you need to require it in your JavaScript file. Here's an example:

```javascript
const Skalex = require("skalex");
```

## Class: Skalex

The `skalex` class represents the main database instance. It provides methods for connecting to and disconnecting from the database, as well as creating and accessing collections.

### Constructor: Skalex(config)

- `config` (object): The database configurations.
  - `path` (string): The directory path of the database.
  - `format` (string): The database files format.

Creates a new instance of the `Skalex` database.

#### Example

```javascript
const db = new Skalex({ path: "./db", format: "json" });
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

#### saveData(collectionName)

- `collectionName` (string, optional): The name of the collection to save.

Saves the data from memory to the database files.

**Returns**: Promise&lt;void&gt;

## Class: Collection

The `Collection` class represents a collection of documents in the `Skalex` database. It provides methods for inserting, updating, deleting, and querying documents in the collection.

### Constructor: Collection()

Creates a new instance of the Collection.

### Methods

#### insertOne(document, options)

- `document` (object): The document to insert.
- `options` (object, optional): The options for the insert operation.
  - `save` (boolean): The save criteria for the operation.

Inserts a single document into the collection.

**Returns**: object

- `data` (object): The inserted document.

#### insertMany(documents, options)

- `documents` (array): An array of documents to insert.
- `options` (object, optional): The options for the insert operation.
  - `save` (boolean): The save criteria for the operation.

Inserts multiple documents into the collection.

**Returns**: object

- `data` (object): The inserted documents.

#### updateOne(filter, update, options)

- `filter` (object): The filter for finding the document to update.
- `update` (object): The fields and values to update in the document.
- `options` (object, optional): The options for the update operation.
  - `save` (boolean): The save criteria for the operation.

Updates a single document in the collection that matches the filter.

**Returns**: object or null

- `data` (object): The updated document, or null if no document was found.

#### updateMany(filter, update, options)

- `filter` (object): The filter for finding the documents to update.
- `update` (object): The fields and values to update in the documents.
- `options` (object, optional): The options for the update operation.
  - `save` (boolean): The save criteria for the operation.

Updates multiple documents in the collection that match the filter.

**Returns**: object

- `data` (object): The updated documents, or an empty array if no documents were found.

#### findOne(filter, options)

- `filter` (object): The filter for finding the document.
- `options` (object, optional): Additional options for the query.
  - `populate` (array): An array of collection names to populate with related data.
  - `select` (array): An array of field names to select from the documents.

Finds and returns a single document from the collection that matches the filter.

**Returns**: object

#### find(filter, options)

- `filter` (object): The filter for finding the documents.
- `options` (object, optional): Additional options for the query.
  - `populate` (array): An array of collection names to populate with related data.
  - `select` (array): An array of field names to select from the documents.
  - `sort` (object): An object of field name to sort from the documents.
  - `page` (number): The number of the page.
  - `limit` (number): THe number of the documents per page.

Finds and returns documents from the collection that match the filter.

**Returns**: object

#### deleteOne(filter, options)

- `filter` (object): The filter for finding the document to delete.
- `options` (object, optional): The options for the delete operation.
  - `save` (boolean): The save criteria for the operation.

Deletes a single document from the collection that matches the filter.

**Returns**: object or null

- `data` (object): The deleted document, or null if no document was found.

#### deleteMany(filter, options)

- `filter` (object): The filter for finding the documents to delete.
- `options` (object, optional): The options for the delete operation.
  - `save` (boolean): The save criteria for the operation.

Deletes multiple documents from the collection that match the filter.

**Returns**: object

- `data` (object): The deleted documents.

#### exportToCSV(filter, options)

- `filter` (object, optional): The filter for exporting specific documents to CSV.
- `options` (object, optional): The options for the export operation.
  - `dir` (string): The directory path of exports.
  - `name` (string): The export file name.
  - `format` (string): The export file format.

Exports the documents from the collection that match the filter to a CSV file.

**Throws**: Error if no matching data is found.

## Utility Functions

### generateUniqueId()

Generates a unique ID string.

**Returns**: string

> This documentation provides an overview of the `Skalex` Library and its main features. For more detailed information on each method and its usage, please refer to the code comments and examples provided in the library documentation examples section.
