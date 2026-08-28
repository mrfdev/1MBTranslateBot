const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTranslationConfig } = require("../src/config");
const { OllamaTranslateClient } = require("../src/ollama-translator");
const { TranslationService } = require("../src/translation-service");

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

test("optional live active pipeline translates a synthetic multiline French sign", { skip: !enabled }, async () => {
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
  const service = new TranslationService({
    mode: "active",
    ollama: client,
    targetLanguage: "en",
    minimumConfidence: config.ollamaMinConfidence,
    maxInputChars: config.ollamaMaxInputChars,
    maxTranslations: 1,
    enableRiskFlag: false
  });

  const result = await service.translate({
    text: "je suis ici\net je peux\nparler français\navec mes amis",
    kind: "sign"
  });
  assert.ok(result, "a multiline French sign must produce a visible active-mode translation");
  assert.equal(result.language, "fr");
  assert.match(result.translations[0].toLocaleLowerCase(), /speak/u);
  assert.match(result.translations[0].toLocaleLowerCase(), /french/u);
  assert.match(result.translations[0].toLocaleLowerCase(), /friends/u);
  assert.equal(result.translations[0].split("\n").length, 4);
});
