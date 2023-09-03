# Usage Examples <!-- {docsify-ignore} -->

---

### 1- Basic operations

The below are examples showcasing the usage of create, insert, update, delete options in the `Skalex` Library:

```javascript
const Skalex = require("skalex");

// Create a new instance of the Skalex database
const db = new Skalex({ path: "./data", format: "json" });

// Connect to the database and load existing data
await db.connect();

// Create a new collection or use an existing one
const collection = db.useCollection("users");

// Insert a document into the collection
const insertedDocument = await collection.insertOne({
  name: "John Doe",
  age: 30,
});

console.log("Inserted document:", insertedDocument);

// Update a document in the collection
const updatedDocument = await collection.updateOne(
  { name: "John Doe" },
  { age: 31 }
);

console.log("Updated document:", updatedDocument);

// Find documents in the collection
const filteredDocuments = await collection.find({ age: { $gte: 30 } });

console.log("Filtered documents:", filteredDocuments.docs);

// Delete a document from the collection
const deletedDocument = await collection.deleteOne({ name: "John Doe" });

console.log("Deleted document:", deletedDocument);

// Disconnect from the database and save data
await db.disconnect();
```

> Please note that these are just basic examples to illustrate the usage of the `Skalex` library. You can explore and utilize the various methods and options provided by the `Skalex` to suit your specific use case and data management requirements.

### 2- Advanced operations

The below are examples showcasing the usage of population and projection options in the `Skalex` Library:

```javascript
const Skalex = require("skalex");

// Create a new instance of the Skalex database
const db = new Skalex({ path: "./data", format: "json" });

// Connect to the database and load existing data
await db.connect();

// Create a new collection or use an existing one
const users = db.useCollection("users");
const posts = db.useCollection("posts");

// Insert a document into the users collection
const insertedUser = await users.insertOne({
  name: "John Doe",
  age: 30,
});

console.log("Inserted user:", insertedUser);

// Insert documents into the posts collection
const insertedPosts = await posts.insertMany([
  { title: "Post 1", users: insertedUser._id },
  { title: "Post 2", users: insertedUser._id },
]);

console.log("Inserted posts:", insertedPosts.docs);

// Find user's posts with populated user information
const userPosts = await posts.find(
  { users: insertedUser._id },
  { populate: ["users"], select: ["title"] }
);

console.log("User's posts:", userPosts.docs);

// Find user's posts with projection (selecting specific fields)
const userPostsProjection = await posts.find(
  { users: insertedUser._id },
  { select: ["title"] }
);

console.log("User's posts with projection:", userPostsProjection.docs);

// Disconnect from the database and save data
await db.disconnect();
```

In the above example, we have two collections: "users" and "posts". After inserting a user document into the "users" collection, we insert two post documents into the "posts" collection, associating them with the user through the "users" collection name and user id.

To demonstrate the population feature, we use the `populate` option when finding the user's posts. This option allows us to retrieve related information from the "users" collection and populate the "users" field with the corresponding user document. In this example, we populate the "users" field with the user information.

Additionally, we showcase the usage of the projection feature with the `select` option. By specifying the `select` array, we can choose to retrieve only specific fields from the documents. In the second `find` operation, we select only the "title" field from the user's posts.
