const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  HealthSnapshotError,
  buildHealthSnapshot,
  evaluateHealth,
  healthFilePath,
  readHealthSnapshot,
  writeHealthSnapshot
} = require("../src/health");

const RELEASE = "a".repeat(40);

function healthyInput(overrides = {}) {
  return {
    version: "1.2.3",
    release: RELEASE,
    startedAt: new Date("2026-08-28T03:00:00.000Z"),
    heartbeatIntervalMs: 30_000,
    lifecycle: "running",
    discord: {
      gateway: "ready",
      server: "available",
      channels: {
        message_log: "available",
        sign_log: "available",
        book_log: "not-configured"
      },
      gateway_errors: 0
    },
    translationMode: "active",
    backend: {
      ollama_service_available: true,
      ollama_model_available: true,
      legacy_available: null,
      checked_at: "2026-08-28T03:04:59.000Z"
    },
    translationMetrics: {
      active_translations: 8,
      active_unchanged: 2,
      local_short_circuits: 1,
      failures: 0,
      ollama: {
        requests: 9,
        errors: 0,
        cache_hits: 3,
        cache_entries: 4,
        cache_capacity: 100,
        cache_ttl_ms: 60_000,
        circuit_state: "closed",
        consecutive_failures: 0,
        circuit_retry_in_ms: 0,
        average_latency_ms: 125,
        active: 0,
        queued: 0,
        max_concurrency: 1,
        queue_limit: 16,
        inflight: 0
      }
    },
    messageQueue: { active: 0, queued: 0, max_concurrency: 2, queue_limit: 100 },
    context: { conversations: 2, peer_routes: 1 },
    ...overrides
  };
}

test("builds a healthy privacy-safe runtime snapshot", () => {
  const snapshot = buildHealthSnapshot(
    healthyInput({
      guildId: "123456789012345678",
      model: "do-not-publish-model-name",
      endpoint: "http://private-host.invalid",
      messageText: "do-not-publish-message-text"
    }),
    new Date("2026-08-28T03:05:00.000Z")
  );

  assert.equal(snapshot.status, "healthy");
  assert.equal(snapshot.attention_required, false);
  assert.deepEqual(snapshot.attention, []);
  assert.equal(snapshot.application.uptime_seconds, 300);
  assert.equal(snapshot.translation.cache.entries, 4);
  assert.equal(snapshot.translation.activity.translated, 8);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /123456789012345678/u);
  assert.doesNotMatch(serialized, /do-not-publish/u);
  assert.doesNotMatch(serialized, /private-host/u);
});

test("marks runtime dependencies and saturated queues as requiring attention", () => {
  const input = healthyInput();
  input.discord.gateway = "disconnected";
  input.backend.ollama_model_available = false;
  input.messageQueue = { active: 2, queued: 100, max_concurrency: 2, queue_limit: 100 };
  const snapshot = buildHealthSnapshot(input, new Date("2026-08-28T03:05:00.000Z"));

  assert.equal(snapshot.status, "attention");
  assert.deepEqual(snapshot.attention, [
    "discord-gateway-not-ready",
    "ollama-model-unavailable",
    "message-queue-saturated"
  ]);
});

test("writes and securely reads an owner-only atomic snapshot", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "translationbot-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = buildHealthSnapshot(
    healthyInput(),
    new Date("2026-08-28T03:05:00.000Z")
  );

  writeHealthSnapshot(root, snapshot);
  assert.deepEqual(readHealthSnapshot(root), snapshot);
  assert.equal(fs.statSync(path.join(root, "logs")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(healthFilePath(root)).mode & 0o777, 0o600);

  fs.chmodSync(healthFilePath(root), 0o644);
  assert.throws(
    () => readHealthSnapshot(root),
    (error) => error instanceof HealthSnapshotError && error.code === "health-snapshot-permissions-invalid"
  );
});

test("evaluates healthy, stale, mismatched, test-alert, and stopped states", () => {
  const generated = new Date("2026-08-28T03:05:00.000Z");
  const snapshot = buildHealthSnapshot(healthyInput(), generated);
  const now = generated.getTime() + 1_000;

  assert.deepEqual(
    evaluateHealth({ snapshot, jobRunning: true, expectedRelease: RELEASE, now }),
    {
      status: "healthy",
      attention_required: false,
      exit_code: 0,
      attention: [],
      snapshot_age_seconds: 1,
      snapshot
    }
  );

  const stale = evaluateHealth({ snapshot, jobRunning: true, maxAgeMs: 500, now });
  assert.equal(stale.status, "attention");
  assert.equal(stale.exit_code, 2);
  assert.ok(stale.attention.includes("health-snapshot-stale"));

  const mismatch = evaluateHealth({
    snapshot,
    jobRunning: true,
    expectedRelease: "b".repeat(40),
    now
  });
  assert.ok(mismatch.attention.includes("release-mismatch"));

  const alert = evaluateHealth({ snapshot, jobRunning: true, alertTest: true, now });
  assert.equal(alert.exit_code, 2);
  assert.ok(alert.attention.includes("alert-test"));

  const stopped = evaluateHealth({ snapshot, jobRunning: false, now });
  assert.equal(stopped.status, "unavailable");
  assert.equal(stopped.exit_code, 3);
  assert.ok(stopped.attention.includes("service-stopped"));
});

test("reports an unavailable snapshot with only a safe error code", () => {
  const snapshotError = new HealthSnapshotError("health-snapshot-unavailable");
  const report = evaluateHealth({ snapshotError, jobRunning: true });
  assert.equal(report.status, "attention");
  assert.equal(report.exit_code, 2);
  assert.deepEqual(report.attention, ["health-snapshot-unavailable"]);
  assert.equal(report.snapshot, null);
});
