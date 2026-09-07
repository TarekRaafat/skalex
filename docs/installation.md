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

> **These docs target v4.0.0-alpha.7.** This is a prerelease. Pin the exact version and review the [migration guide](https://github.com/TarekRaafat/skalex/blob/master/MIGRATION.md) before upgrading. `npm install skalex` installs the last stable v3 - use `@alpha` to get v4.

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

For a manual or LLM-assisted upgrade, follow the [migration checklist](https://tarekraafat.github.io/skalex/#/migration) and apply every change required by your starting version.


### Package entry points

Adapter constructors are runtime exports of skalex/connectors and its subpaths. Their root names are type-only, as are Memory, ChangeLog, SkalexMCPServer and the named Skalex type. Import the database constructor as the default export. Obtain memory, changelog and MCP instances through their database factories. findOne accepts populate, select, includeDeleted and clone, not sort/page/limit/session. Use find for sorting and pagination. Compound index declarations accept arrays of field names.

MCP tool definitions and handlers load on the first tool request. Keep the package's src/connectors/mcp/tools.js and src/engine/errors.js alongside dist, as well as the existing optional HTTP transport. The documentation distribution includes matching modules under docs/src. Error constructors are shared within a JavaScript realm through a non-enumerable, immutable registry keyed by Symbol.for("skalex.errors.v4"). ESM, CJS and source connectors retain the same error constructors and normal instanceof semantics. Separate realms are not covered.
