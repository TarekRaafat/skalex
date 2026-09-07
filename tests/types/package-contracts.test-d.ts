import { expectError, expectType } from "tsd";
import Skalex, { FsAdapter, Memory, ChangeLog, SkalexMCPServer, Skalex as NamedSkalex } from "../../dist/skalex.js";
import { FsAdapter as ConnectorFsAdapter } from "../../src/connectors/index.js";

// @ts-expect-error This entry exports a type, not a runtime constructor.
new FsAdapter({ dir: "./data" });
// @ts-expect-error This entry exports a type, not a runtime constructor.
new Memory();
// @ts-expect-error This entry exports a type, not a runtime constructor.
new ChangeLog();
// @ts-expect-error This entry exports a type, not a runtime constructor.
new SkalexMCPServer();
// @ts-expect-error This entry exports a type, not a runtime constructor.
new NamedSkalex();
new ConnectorFsAdapter({ dir: "./data" });
const db = new Skalex();
const col = db.createCollection("items", { indexes: [["a", "b"]] });
expectError(col.findOne({}, { sort: { value: -1 } }));
expectError(col.findOne({}, { page: 2 }));
expectError(col.findOne({}, { limit: 1 }));
expectError(col.findOne({}, { session: "session" }));
expectType<ReturnType<typeof col.findOne>>(col.findOne({}, { select: ["value"], clone: true }));
