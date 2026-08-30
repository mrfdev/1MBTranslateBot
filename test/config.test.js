const assert = require("node:assert/strict");
const test = require("node:test");
const { loadConfig, loadTranslationConfig } = require("../src/config");

test("uses conservative local Ollama defaults", () => {
  const config = loadTranslationConfig({});
  assert.equal(config.translationMode, "active");
  assert.equal(config.ollamaBaseUrl, "http://127.0.0.1:11434");
  assert.equal(config.ollamaModel, "qwen3:8b");
  assert.equal(config.ollamaMinConfidence, 0.9);
  assert.equal(config.ollamaMaxConcurrency, 1);
  assert.equal(config.ollamaQueueLimit, 16);
});

test("supports off, shadow, and active rollout modes", () => {
  for (const mode of ["off", "shadow", "active"]) {
    assert.equal(loadTranslationConfig({ OLLAMA_MODE: mode }).translationMode, mode);
  }
  assert.throws(
    () => loadTranslationConfig({ OLLAMA_MODE: "fallback" }),
    /invalid-environment-enum/u
  );
});

test("rejects every non-loopback endpoint and cloud model name", () => {
  for (const endpoint of [
    "http://0.0.0.0:11434",
    "http://192.168.1.20:11434",
    "https://127.0.0.1:11434",
    "https://ollama.com/api"
  ]) {
    assert.throws(
      () => loadTranslationConfig({ OLLAMA_BASE_URL: endpoint }),
      /must-be-loopback-http/u,
      endpoint
    );
  }
  assert.throws(
    () => loadTranslationConfig({ OLLAMA_MODEL: "gpt-oss:20b-cloud" }),
    /must-name-a-local-model/u
  );
});

test("legacy and shadow modes also require a loopback-only legacy endpoint", () => {
  assert.throws(
    () =>
      loadTranslationConfig({
        OLLAMA_MODE: "shadow",
        LIBRETRANSLATE_URL: "https://example.com"
      }),
    /LIBRETRANSLATE_URL-must-be-loopback-http/u
  );

  assert.doesNotThrow(() =>
    loadTranslationConfig({
      OLLAMA_MODE: "active",
      LIBRETRANSLATE_URL: "https://example.com"
    })
  );
});

test("requires Discord identifiers instead of embedding private defaults", () => {
  assert.throws(
    () => loadConfig({}),
    /missing-environment-variable:DISCORD_TOKEN/u
  );
  const config = loadConfig({
    DISCORD_TOKEN: "test-token",
    DISCORD_GUILD_ID: "guild",
    LOG_CHANNEL_ID: "logs",
    SOURCE_BOT_IDS: "trusted-source"
  });
  assert.equal(config.guildId, "guild");
  assert.equal(config.logChannelId, "logs");
  assert.equal(config.signChannelId, "");
  assert.equal(config.bookChannelId, "");
  assert.deepEqual([...config.sourceBotIds], ["trusted-source"]);
  assert.deepEqual([...config.ignoredPlayerNames], []);
  assert.equal(config.allowAnySource, false);
  assert.equal(config.messageMaxCandidates, 16);
  assert.equal(config.messageProcessingBudgetMs, 60_000);
  assert.equal(config.messageMaxOutputChunks, 8);
  assert.equal(config.healthSnapshotIntervalMs, 30_000);
  assert.equal(
    loadConfig({
      DISCORD_TOKEN: "test-token",
      DISCORD_GUILD_ID: "guild",
      LOG_CHANNEL_ID: "logs",
      SOURCE_BOT_IDS: "trusted-source",
      HEALTH_SNAPSHOT_INTERVAL_MS: "5000"
    }).healthSnapshotIntervalMs,
    5_000
  );
  assert.throws(
    () =>
      loadConfig({
        DISCORD_TOKEN: "test-token",
        DISCORD_GUILD_ID: "guild",
        LOG_CHANNEL_ID: "logs",
        SOURCE_BOT_IDS: "trusted-source",
        HEALTH_SNAPSHOT_INTERVAL_MS: "4999"
      }),
    /invalid-number-environment-value/u
  );
});

test("normalizes configured ignored player names for exact matching", () => {
  const config = loadConfig({
    DISCORD_TOKEN: "test-token",
    DISCORD_GUILD_ID: "guild",
    LOG_CHANNEL_ID: "logs",
    SOURCE_BOT_IDS: "trusted-source",
    IGNORED_PLAYER_NAMES: " RegularOne, regularone, SECOND_PLAYER, ,"
  });

  assert.deepEqual([...config.ignoredPlayerNames], ["regularone", "second_player"]);
});

test("requires an authenticated or explicitly opted-in message source", () => {
  const required = {
    DISCORD_TOKEN: "test-token",
    DISCORD_GUILD_ID: "guild",
    LOG_CHANNEL_ID: "logs"
  };
  assert.throws(() => loadConfig(required), /missing-trusted-message-source/u);
  assert.doesNotThrow(() => loadConfig({ ...required, SOURCE_BOT_IDS: "bot-one,bot-two" }));
  assert.doesNotThrow(() => loadConfig({ ...required, SOURCE_WEBHOOK_IDS: "webhook-one" }));
  assert.doesNotThrow(() => loadConfig({ ...required, ALLOW_ANY_SOURCE: "true" }));
  assert.doesNotThrow(() => loadConfig({ ...required, TRANSLATE_HUMAN_MESSAGES: "true" }));
});
