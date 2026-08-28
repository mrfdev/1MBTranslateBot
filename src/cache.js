class BoundedTtlCache {
  constructor(options = {}) {
    this.maxEntries = Math.max(0, Math.floor(Number(options.maxEntries) || 0));
    this.ttlMs = Math.max(0, Math.floor(Number(options.ttlMs) || 0));
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.entries = new Map();
    this.nextPruneAt = 0;
  }

  get size() {
    this.pruneExpired();
    return this.entries.size;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // Map iteration order doubles as the least-recently-used order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.maxEntries === 0 || this.ttlMs === 0) {
      return value;
    }

    const now = this.now();
    if (now >= this.nextPruneAt) {
      this.pruneExpired(now);
      this.nextPruneAt = now + Math.min(this.ttlMs, 60000);
    }
    this.entries.delete(key);

    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }

    this.entries.set(key, {
      value,
      expiresAt: now + this.ttlMs
    });
    return value;
  }

  clear() {
    this.entries.clear();
    this.nextPruneAt = 0;
  }

  pruneExpired(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

module.exports = {
  BoundedTtlCache
};
