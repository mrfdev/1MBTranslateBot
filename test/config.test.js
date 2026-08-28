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
    LOG_CHANNEL_ID: "logs"
  });
  assert.equal(config.guildId, "guild");
  assert.equal(config.logChannelId, "logs");
  assert.equal(config.signChannelId, "");
  assert.equal(config.bookChannelId, "");
});
