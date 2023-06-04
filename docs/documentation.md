# Documentation <!-- {docsify-ignore} -->

---

To start using the `Skalex` library, you need to require it in your JavaScript file. Here's an example:

```javascript
const Skalex = require("skalex");
```

## Class: Skalex

The `skalex` class represents the main database instance. It provides methods for connecting to and disconnecting from the database, as well as creating and accessing collections.

### Constructor: Skalex(dataDirectory)

- `dataDirectory` (string): The directory where the database files will be stored.

Creates a new instance of the `Skalex` database.

#### Example

```javascript
const db = new Skalex("./db");
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

#### saveData()

Saves the data from memory to the database files.

**Returns**: Promise&lt;void&gt;

## Class: Collection

The `Collection` class represents a collection of documents in the `Skalex` database. It provides methods for inserting, updating, deleting, and querying documents in the collection.

### Constructor: Collection()

Creates a new instance of the Collection.

### Methods

#### insertOne(document)

- `document` (object): The document to insert.

Inserts a single document into the collection.

**Returns**: object

- `data` (object): The inserted document.
- `save()` (function): Saves the collection data to the database.

#### insertMany(documents)

- `documents` (array): An array of documents to insert.

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

#### findOne(filter, options)

- `filter` (object): The filter for finding the document.
- `options` (object, optional): Additional options for the query.
  - `populate` (array): An array of collection names to populate with related data.
  - `select` (array): An array of field names to select from the documents.

Finds and returns a single document from the collection that matches the filter.

**Returns**: object or null

#### find(filter, options)

- `filter` (object): The filter for finding the documents.
- `options` (object, optional): Additional options for the query.
  - `populate` (array): An array of collection names to populate with related data.
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

## Utility Functions

### generateUniqueId()

Generates a unique ID string.

**Returns**: string

> This documentation provides an overview of the `Skalex` Library and its main features. For more detailed information on each method and its usage, please refer to the code comments and examples provided in the library documentation examples section.
