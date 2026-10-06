const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const discord = require("discord.js");
const health = require("../src/health");

function loadRuntime() {
  const indexPath = path.resolve(__dirname, "../src/index.js");
  const runtimeRequire = createRequire(indexPath);
  const snapshots = [];
  let client;

  class FakeClient extends EventEmitter {
    constructor() {
      super();
      client = this;
    }

    login() {
      return Promise.resolve();
    }
  }

  class FakeMetrics {
    metricsSnapshot() {
      return {};
    }

    snapshot() {
      return {};
    }
  }

  // Exercise the real runtime event wiring without credentials, network calls,
  // timers, signal handlers, or writes to the project's health file.
  const dependencies = {
    "discord.js": { ...discord, Client: FakeClient },
    "./config": {
      loadConfig: () => ({ translationMode: "active", healthSnapshotIntervalMs: 30_000 })
    },
    "./health": {
      ...health,
      writeHealthSnapshot: (_, snapshot) => snapshots.push(snapshot)
    },
    "./translation-service": { TranslationService: FakeMetrics },
    "./ollama-translator": { OllamaTranslateClient: FakeMetrics, BoundedExecutor: FakeMetrics },
    "./context": { ConversationContextStore: FakeMetrics }
  };
  vm.runInNewContext(fs.readFileSync(indexPath, "utf8"), {
    require: (name) => dependencies[name] ?? runtimeRequire(name),
    __dirname: path.dirname(indexPath),
    process: { env: {}, once() {} },
    console,
    setInterval: () => ({ unref() {} }),
    clearInterval() {}
  }, { filename: indexPath });

  return { client, snapshots };
}

test("a resumed Discord session immediately clears the gateway health alert", () => {
  const { client, snapshots } = loadRuntime();
  client.emit(discord.Events.ShardReady, 0);
  assert.equal(snapshots.at(-1).discord.gateway, "ready");

  client.emit(discord.Events.ShardReconnecting, 0);
  assert.equal(snapshots.at(-1).discord.gateway, "connecting");
  assert.ok(snapshots.at(-1).attention.includes("discord-gateway-not-ready"));
  const snapshotCount = snapshots.length;

  // discord.js emits ShardResume, rather than ShardReady, for a resumed session.
  client.emit(discord.Events.ShardResume, 0, 2);
  assert.equal(snapshots.at(-1).discord.gateway, "ready");
  assert.equal(snapshots.length, snapshotCount + 1);
  assert.equal(snapshots.at(-1).attention.includes("discord-gateway-not-ready"), false);
  assert.equal(snapshots.at(-1).discord.gateway_errors, 0);
});
