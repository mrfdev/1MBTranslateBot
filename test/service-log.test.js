const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  SERVICE_LOG_NAMES,
  createRotatingLogSink,
  parseServiceLogOptions,
  sanitizeServiceLogText
} = require("../src/service-log");

test("rotates private service logs before their configured bound", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "translationbot-logs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sink = createRotatingLogSink({
    directory,
    fileName: SERVICE_LOG_NAMES.info,
    maxBytes: 90,
    maxFiles: 2,
    minFreeBytes: 1,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    getAvailableBytes: () => 1_000_000
  });
  sink.write("first bounded record");
  sink.write("second bounded record");
  assert.equal(fs.existsSync(path.join(directory, `${SERVICE_LOG_NAMES.info}.1`)), true);
  assert.equal(fs.statSync(path.join(directory, SERVICE_LOG_NAMES.info)).mode & 0o077, 0);
  assert.equal(sink.getSnapshot().rotations, 1);
});

test("protects the disk reserve and sanitizes operational output", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "translationbot-reserve-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sink = createRotatingLogSink({
    directory,
    fileName: SERVICE_LOG_NAMES.error,
    maxBytes: 1_000,
    maxFiles: 2,
    minFreeBytes: 500,
    getAvailableBytes: () => 100
  });
  assert.equal(sink.write("should not consume the reserve"), false);
  assert.equal(sink.getSnapshot().lastDropReason, "disk-reserve");
  assert.equal(sanitizeServiceLogText("path /Users/example/private token 123456789012345678"), "path [path] token [id]");
});

test("bounds service log configuration", () => {
  assert.deepEqual(parseServiceLogOptions({
    SERVICE_LOG_MAX_SIZE_MB: "2",
    SERVICE_LOG_MAX_FILES: "3",
    SERVICE_LOG_MIN_FREE_MB: "128"
  }), {
    maxBytes: 2 * 1024 * 1024,
    maxFiles: 3,
    minFreeBytes: 128 * 1024 * 1024
  });
});
