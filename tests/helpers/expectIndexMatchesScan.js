import { expect } from "vitest";

/**
 * Compare a scalar equality query with independently filtered full-scan results.
 * Comparing complete documents preserves duplicate counts and catches stale values.
 */
export default async function expectIndexMatchesScan(col, fields, value) {
  const filter = typeof fields === "string" ? { [fields]: value } : fields;
  const scan = (await col.find({})).docs.filter(doc =>
    Object.entries(filter).every(([field, expected]) => doc[field] === expected)
  );
  const indexed = (await col.find(filter)).docs;
  const byId = (a, b) => String(a._id).localeCompare(String(b._id));
  expect(indexed.sort(byId)).toEqual(scan.sort(byId));
}
