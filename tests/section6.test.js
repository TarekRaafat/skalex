const path = require('path');
const fs = require('fs');
const Skalex = require('../src/index');

const TEST_DB_PATH = path.resolve(__dirname, '.test-db-s6');

function cleanup() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterAll(cleanup);

describe('Section 6 — P2 Code Quality', () => {
  // FIX-15: filesys class renamed to FileSystem
  test('FIX-15: filesys exports FileSystem class', () => {
    const FileSystem = require('../src/filesys');
    expect(FileSystem.name).toBe('FileSystem');
  });

  // FIX-16: generateUniqueId uses crypto
  test('FIX-16: generateUniqueId produces hex-based 24-char IDs', () => {
    const { generateUniqueId } = require('../src/utils');
    const id = generateUniqueId();
    expect(id).toHaveLength(24);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);

    // Verify uniqueness in a batch
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateUniqueId());
    }
    expect(ids.size).toBe(1000);
  });

  // FIX-17: loadData distinguishes ENOENT from corrupt file
  test('FIX-17: loadData handles missing directory gracefully', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await expect(db.connect()).resolves.toBeUndefined();
    await db.disconnect();
  });

  test('FIX-17: loadData warns on corrupt file but does not throw', async () => {
    // Create a corrupt file in the DB directory
    fs.mkdirSync(TEST_DB_PATH, { recursive: true });
    fs.writeFileSync(path.join(TEST_DB_PATH, 'corrupt.json'), 'NOT VALID JSON');

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const db = new Skalex({ path: TEST_DB_PATH, format: 'json' });
    await db.connect();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: Could not load collection')
    );
    errorSpy.mockRestore();
    await db.disconnect();
  });

  // FIX-18: export and saveData re-throw
  test('FIX-18: export() re-throws on error', async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection('users');

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(users.export({ name: 'NonExistent' })).rejects.toThrow();
    errorSpy.mockRestore();
    await db.disconnect();
  });

  // FIX-19: package.json has exports map
  test('FIX-19: package.json has exports and engines >= 18', () => {
    const pkg = require('../package.json');
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['.']).toBeDefined();
    expect(pkg.exports['.'].require).toBe('./src/index.js');
    expect(pkg.exports['.'].import).toBe('./src/index.js');
    expect(pkg.engines.node).toBe('>=18.0.0');
    expect(pkg.module).toBe('./src/index.js');
  });
});
