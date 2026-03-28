const path = require('path');
const fs = require('fs');
const Skalex = require('../src/index');

const TEST_DB_PATH = path.resolve(__dirname, '.test-db-s4');

function cleanup() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterAll(cleanup);

describe('Section 4 — P1 API Inconsistencies', () => {
  // FIX-12: Standardised return shapes
  test('FIX-12: insertOne returns { data }', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection('users');
    const r = await users.insertOne({ name: 'Alice' });
    expect(r.data).toBeDefined();
    expect(r.data.name).toBe('Alice');
    await db.disconnect();
  });

  test('FIX-12: updateOne returns { data }', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection('users');
    await users.insertOne({ name: 'Alice' });
    const r = await users.updateOne({ name: 'Alice' }, { age: 30 });
    expect(r.data).toBeDefined();
    expect(r.data.age).toBe(30);
    await db.disconnect();
  });

  test('FIX-12: deleteOne returns { data }', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection('users');
    await users.insertOne({ name: 'Alice' });
    const r = await users.deleteOne({ name: 'Alice' });
    expect(r.data).toBeDefined();
    expect(r.data.name).toBe('Alice');
    await db.disconnect();
  });

  test('FIX-12: updateMany returns { docs } even when empty', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection('users');
    const r = await users.updateMany({ name: 'Nobody' }, { age: 0 });
    expect(Array.isArray(r.docs)).toBe(true);
    expect(r.docs).toHaveLength(0);
    await db.disconnect();
  });

  // FIX-13: insertOne sets updatedAt
  test('FIX-13: insertOne sets updatedAt', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection('users');
    const { data: doc } = await users.insertOne({ name: 'Alice' });
    expect(doc.updatedAt).toBeDefined();
    expect(doc.updatedAt instanceof Date).toBe(true);
    await db.disconnect();
  });

  test('FIX-13: applyUpdate sets updatedAt once per call', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection('users');
    await users.insertOne({ name: 'Alice', age: 25 });
    const r = await users.updateOne({ name: 'Alice' }, { age: 30, role: 'admin' });
    expect(r.data.updatedAt).toBeDefined();
    expect(r.data.updatedAt instanceof Date).toBe(true);
    await db.disconnect();
  });
});
