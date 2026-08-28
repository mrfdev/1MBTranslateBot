const assert = require("node:assert/strict");
const test = require("node:test");
const { BoundedTtlCache } = require("../src/cache");

test("bounds cache size, expires entries, and evicts the least recently used entry", () => {
  let now = 0;
  const cache = new BoundedTtlCache({
    maxEntries: 2,
    ttlMs: 100,
    now: () => now
  });

  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);

  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);

  now = 101;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
  assert.equal(cache.size, 0);
});

test("allows caching to be disabled", () => {
  const cache = new BoundedTtlCache({ maxEntries: 0, ttlMs: 100 });
  cache.set("a", 1);
  assert.equal(cache.get("a"), undefined);
});
