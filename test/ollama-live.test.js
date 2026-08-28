const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTranslationConfig } = require("../src/config");
const { OllamaTranslateClient } = require("../src/ollama-translator");

const enabled = process.env.RUN_OLLAMA_INTEGRATION === "1";

test("optional live Ollama translation stays local and preserves protected data", { skip: !enabled }, async () => {
  const config = loadTranslationConfig();
  const client = new OllamaTranslateClient({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
    targetLanguage: "en",
    timeoutMs: config.ollamaTimeoutMs,
    statusTimeoutMs: config.ollamaStatusTimeoutMs,
    keepAlive: config.ollamaKeepAlive,
    maxInputChars: config.ollamaMaxInputChars,
    maxOutputChars: config.maxTranslationLength,
    maxOutputTokens: config.ollamaMaxOutputTokens,
    maxResponseBytes: config.ollamaMaxResponseBytes,
    maxConcurrency: 1,
    queueLimit: 1,
    cacheMaxEntries: 0,
    cacheTtlMs: 0
  });

  assert.deepEqual(await client.healthCheck(), {
    serviceAvailable: true,
    modelAvailable: true
  });
  const result = await client.analyze({
    text: "%player%, kun je me helpen met mijn winkel?",
    kind: "integration-test"
  });
  assert.equal(result.decision, "translate");
  assert.ok(result.confidence >= config.ollamaMinConfidence);
  assert.match(result.translation.toLocaleLowerCase(), /help/u);
  assert.match(result.translation.toLocaleLowerCase(), /shop|store/u);
  assert.match(result.translation, /%player%/u);
  assert.match(result.translation, /\?/u);
});
