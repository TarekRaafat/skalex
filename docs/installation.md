# Installation <!-- {docsify-ignore} -->

In 30 seconds, you'll have a database running. No server to provision. No config file to write. No DevOps required.

---

## Requirements

- Node.js `>=18.0.0`

---

## Install

```bash
npm install skalex@alpha
```

> **v4.0.0-alpha.6 is the current release.** `npm install skalex` installs the last stable v3 - use `@alpha` to get v4.

---

## Import

**CommonJS (Node.js)**

```javascript
const Skalex = require("skalex");
```

**ESM**

```javascript
import Skalex from "skalex";
```

**TypeScript**

```typescript
import Skalex from "skalex";
import type { Collection, SkalexConfig } from "skalex";

// Runtime named exports (error types + Collection)
import Skalex, { Collection, ValidationError, UniqueConstraintError } from "skalex";
```

---

## Quick Start

That's the entire setup. Now you can build.

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./.db" });

await db.connect();

const users = db.useCollection("users");

const doc = await users.insertOne({ name: "Alice", age: 30 });

console.log(doc._id); // "0196f3a2b4c8d1e..."

await db.disconnect();
```
