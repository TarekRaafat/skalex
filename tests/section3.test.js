const path = require('path');
const fs = require('fs');
const Skalex = require('../src/index');

const TEST_DB_PATH = path.resolve(__dirname, '.test-db-s3');

function cleanup() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterAll(cleanup);

describe('Section 3 — P1 Architectural Anti-patterns', () => {
  // FIX-09: collection.js no longer imports native fs/path
  test('FIX-09: collection.js does not import native fs or path', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/collection.js'), 'utf8');
    expect(src).not.toMatch(/require\(["']fs["']\)/);
    expect(src).not.toMatch(/require\(["']path["']\)/);
  });

  test('FIX-09: export() works through the adapter', async () => {
    const db = new Skalex({ path: TEST_DB_PATH, format: 'json' });
    await db.connect();
    const users = db.useCollection('users');
    await users.insertOne({ name: 'Alice', age: 30 });

    const exportDir = path.resolve(TEST_DB_PATH, 'exports');
    await users.export({}, { format: 'json', dir: exportDir });

    const exported = JSON.parse(fs.readFileSync(path.join(exportDir, 'users.json'), 'utf8'));
    expect(Array.isArray(exported)).toBe(true);
    expect(exported[0].name).toBe('Alice');

    await users.export({}, { format: 'csv', dir: exportDir });
    const csv = fs.readFileSync(path.join(exportDir, 'users.csv'), 'utf8');
    expect(csv).toContain('name');
    expect(csv).toContain('Alice');

    await db.disconnect();
  });

  // FIX-10: useCollection returns cached singleton
  test('FIX-10: useCollection() returns the same instance', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const c1 = db.useCollection('users');
    const c2 = db.useCollection('users');
    expect(c1).toBe(c2);
    await db.disconnect();
  });

  // FIX-11: encapsulation — _data/_index not exposed as .data/.index
  test('FIX-11: Collection exposes _data but not .data', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const c = db.useCollection('users');
    expect(c._data).toBeDefined();
    expect(c.data).toBeUndefined();
    expect(c._index).toBeDefined();
    expect(c.index).toBeUndefined();
    await db.disconnect();
  });
});
