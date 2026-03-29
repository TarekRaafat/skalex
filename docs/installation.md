# Installation <!-- {docsify-ignore} -->

---

## Requirements

- Node.js `>=18.0.0`

---

## Install

```bash
npm i skalex
```

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
```

---

## Quick Start

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./.db" });

await db.connect();

const users = db.useCollection("users");

const { data } = await users.insertOne({ name: "Alice", age: 30 });

console.log(data._id); // "0196f3a2b4c8d1e..."

await db.disconnect();
```
