const fs = require("node:fs");
const path = require("node:path");

const HEALTH_FILE_NAME = "translationbot-health.json";
const HEALTH_SCHEMA_VERSION = 1;
const MAX_HEALTH_BYTES = 64 * 1024;
const SAFE_STATE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

class HealthSnapshotError extends Error {
  constructor(code) {
    super(code);
    this.name = "HealthSnapshotError";
    this.code = code;
  }
}

function finiteInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function safeState(value, fallback = "unknown") {
  const normalized = String(value || "").trim().toLocaleLowerCase();
  return SAFE_STATE.test(normalized) ? normalized : fallback;
}

function releaseIdentity(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase();
  return /^[0-9a-f]{40}$/u.test(normalized) ? normalized : "development";
}

function collectAttention(snapshot) {
  const attention = [];
  const add = (condition, code) => {
    if (condition) {
      attention.push(code);
    }
  };

  add(snapshot.lifecycle !== "running", `service-${snapshot.lifecycle}`);
  add(snapshot.discord.gateway !== "ready", "discord-gateway-not-ready");
  add(snapshot.discord.server !== "available", "discord-server-unavailable");
  add(snapshot.discord.channels.message_log !== "available", "message-log-channel-unavailable");
  add(
    !["available", "not-configured"].includes(snapshot.discord.channels.sign_log),
    "sign-log-channel-unavailable"
  );
  add(
    !["available", "not-configured"].includes(snapshot.discord.channels.book_log),
    "book-log-channel-unavailable"
  );

  if (["active", "shadow"].includes(snapshot.translation.mode)) {
    add(snapshot.translation.backend.ollama_service_available !== true, "ollama-service-unavailable");
    add(snapshot.translation.backend.ollama_model_available !== true, "ollama-model-unavailable");
    add(snapshot.translation.circuit.state === "open", "ollama-circuit-open");
  }
  if (["off", "shadow"].includes(snapshot.translation.mode)) {
    add(snapshot.translation.backend.legacy_available !== true, "legacy-translator-unavailable");
  }
  add(
    snapshot.queues.messages.queue_limit > 0 &&
      snapshot.queues.messages.queued >= snapshot.queues.messages.queue_limit,
    "message-queue-saturated"
  );
  add(
    snapshot.queues.ollama.queue_limit > 0 &&
      snapshot.queues.ollama.queued >= snapshot.queues.ollama.queue_limit,
    "ollama-queue-saturated"
  );
  return [...new Set(attention)];
}

function buildHealthSnapshot(input = {}, now = new Date()) {
  const generatedAt = now instanceof Date ? now : new Date(now);
  const startedAt = new Date(input.startedAt || generatedAt);
  const translationMetrics = input.translationMetrics || {};
  const ollamaMetrics = translationMetrics.ollama || {};
  const legacyMetrics = input.legacyMetrics || {};
  const messageQueue = input.messageQueue || {};
  const context = input.context || {};
  const backend = input.backend || {};
  const lifecycle = safeState(input.lifecycle, "starting");

  const snapshot = {
    schema_version: HEALTH_SCHEMA_VERSION,
    generated_at: generatedAt.toISOString(),
    lifecycle,
    application: {
      name: "TranslationBot",
      version: String(input.version || "0.0.0").slice(0, 64),
      release: releaseIdentity(input.release),
      node_version: String(process.versions.node).slice(0, 32),
      uptime_seconds: finiteInteger((generatedAt.getTime() - startedAt.getTime()) / 1_000),
      rss_mb: finiteInteger(process.memoryUsage().rss / 1024 / 1024),
      heartbeat_interval_ms: finiteInteger(input.heartbeatIntervalMs, 30_000)
    },
    discord: {
      gateway: safeState(input.discord?.gateway, "unknown"),
      server: safeState(input.discord?.server, "unknown"),
      channels: {
        message_log: safeState(input.discord?.channels?.message_log, "unknown"),
        sign_log: safeState(input.discord?.channels?.sign_log, "unknown"),
        book_log: safeState(input.discord?.channels?.book_log, "unknown")
      },
      gateway_errors: finiteInteger(input.discord?.gateway_errors)
    },
    translation: {
      mode: safeState(input.translationMode, "unknown"),
      backend: {
        ollama_service_available:
          typeof backend.ollama_service_available === "boolean"
            ? backend.ollama_service_available
            : null,
        ollama_model_available:
          typeof backend.ollama_model_available === "boolean"
            ? backend.ollama_model_available
            : null,
        legacy_available:
          typeof backend.legacy_available === "boolean" ? backend.legacy_available : null,
        checked_at: backend.checked_at || null
      },
      cache: {
        entries: finiteInteger(ollamaMetrics.cache_entries ?? legacyMetrics.cache_entries),
        max_entries: finiteInteger(
          ollamaMetrics.cache_capacity ?? legacyMetrics.cache_capacity ?? input.cacheMaxEntries
        ),
        ttl_ms: finiteInteger(
          ollamaMetrics.cache_ttl_ms ?? legacyMetrics.cache_ttl_ms ?? input.cacheTtlMs
        ),
        hits: finiteInteger(ollamaMetrics.cache_hits)
      },
      circuit: {
        state: safeState(ollamaMetrics.circuit_state, "not-applicable"),
        consecutive_failures: finiteInteger(ollamaMetrics.consecutive_failures),
        retry_in_ms: finiteInteger(ollamaMetrics.circuit_retry_in_ms)
      },
      activity: {
        translated: finiteInteger(translationMetrics.active_translations),
        unchanged: finiteInteger(translationMetrics.active_unchanged),
        short_circuits: finiteInteger(translationMetrics.local_short_circuits),
        failures: finiteInteger(translationMetrics.failures),
        provider_requests: finiteInteger(ollamaMetrics.requests),
        provider_errors: finiteInteger(ollamaMetrics.errors),
        average_latency_ms: finiteInteger(ollamaMetrics.average_latency_ms)
      }
    },
    queues: {
      messages: {
        active: finiteInteger(messageQueue.active),
        queued: finiteInteger(messageQueue.queued),
        max_concurrency: finiteInteger(messageQueue.max_concurrency),
        queue_limit: finiteInteger(messageQueue.queue_limit)
      },
      ollama: {
        active: finiteInteger(ollamaMetrics.active),
        queued: finiteInteger(ollamaMetrics.queued),
        max_concurrency: finiteInteger(ollamaMetrics.max_concurrency),
        queue_limit: finiteInteger(ollamaMetrics.queue_limit),
        inflight: finiteInteger(ollamaMetrics.inflight)
      }
    },
    context: {
      conversations: finiteInteger(context.conversations),
      peer_routes: finiteInteger(context.peer_routes)
    }
  };
  snapshot.attention = collectAttention(snapshot);
  snapshot.attention_required = snapshot.attention.length > 0;
  snapshot.status = snapshot.attention_required ? "attention" : "healthy";
  return snapshot;
}

function healthFilePath(projectRoot) {
  return path.resolve(projectRoot, "logs", HEALTH_FILE_NAME);
}

function writeHealthSnapshot(projectRoot, snapshot) {
  const logsDirectory = path.resolve(projectRoot, "logs");
  const destination = healthFilePath(projectRoot);
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(logsDirectory, 0o700);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
  }
}

function validateHealthSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new HealthSnapshotError("health-snapshot-invalid");
  }
  if (snapshot.schema_version !== HEALTH_SCHEMA_VERSION) {
    throw new HealthSnapshotError("health-schema-unsupported");
  }
  if (!Number.isFinite(Date.parse(snapshot.generated_at))) {
    throw new HealthSnapshotError("health-timestamp-invalid");
  }
  if (!snapshot.application || !snapshot.discord || !snapshot.translation || !snapshot.queues) {
    throw new HealthSnapshotError("health-snapshot-incomplete");
  }
  if (!Array.isArray(snapshot.attention) || snapshot.attention.some((code) => !SAFE_STATE.test(code))) {
    throw new HealthSnapshotError("health-attention-invalid");
  }
  return snapshot;
}

function readHealthSnapshot(projectRoot) {
  const destination = healthFilePath(projectRoot);
  let descriptor;
  try {
    descriptor = fs.openSync(
      destination,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw new HealthSnapshotError("health-snapshot-unavailable");
  }
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size < 2 || stats.size > MAX_HEALTH_BYTES) {
      throw new HealthSnapshotError("health-snapshot-invalid");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new HealthSnapshotError("health-snapshot-owner-invalid");
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new HealthSnapshotError("health-snapshot-permissions-invalid");
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch {
      throw new HealthSnapshotError("health-snapshot-invalid");
    }
    return validateHealthSnapshot(parsed);
  } finally {
    fs.closeSync(descriptor);
  }
}

function evaluateHealth({
  snapshot,
  snapshotError,
  jobRunning,
  expectedRelease,
  maxAgeMs = 90_000,
  now = Date.now(),
  alertTest = false
} = {}) {
  const attention = new Set();
  let snapshotAgeMs = null;
  if (snapshotError) {
    attention.add(safeState(snapshotError.code, "health-snapshot-unavailable"));
  }
  if (snapshot) {
    for (const code of snapshot.attention || []) {
      attention.add(code);
    }
    snapshotAgeMs = Math.max(0, now - Date.parse(snapshot.generated_at));
    if (!Number.isFinite(snapshotAgeMs) || snapshotAgeMs > maxAgeMs) {
      attention.add("health-snapshot-stale");
    }
    if (
      expectedRelease &&
      expectedRelease !== "development" &&
      snapshot.application.release !== expectedRelease
    ) {
      attention.add("release-mismatch");
    }
  }
  if (!jobRunning) {
    attention.add("service-stopped");
  }
  if (alertTest) {
    attention.add("alert-test");
  }

  const codes = [...attention].sort();
  const unavailable = !jobRunning;
  return {
    status: unavailable ? "unavailable" : codes.length > 0 ? "attention" : "healthy",
    attention_required: codes.length > 0,
    exit_code: unavailable ? 3 : codes.length > 0 ? 2 : 0,
    attention: codes,
    snapshot_age_seconds:
      snapshotAgeMs === null || !Number.isFinite(snapshotAgeMs)
        ? null
        : Math.round(snapshotAgeMs / 1_000),
    snapshot: snapshot || null
  };
}

module.exports = {
  HEALTH_FILE_NAME,
  HEALTH_SCHEMA_VERSION,
  HealthSnapshotError,
  buildHealthSnapshot,
  collectAttention,
  evaluateHealth,
  healthFilePath,
  readHealthSnapshot,
  releaseIdentity,
  validateHealthSnapshot,
  writeHealthSnapshot
};
