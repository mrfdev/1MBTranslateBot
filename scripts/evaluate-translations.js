#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { loadTranslationConfig } = require("../src/config");
const { evaluateCorpus } = require("../src/evaluation");
const { OllamaTranslateClient } = require("../src/ollama-translator");

async function main() {
  const config = loadTranslationConfig();
  const client = new OllamaTranslateClient({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
    targetLanguage: config.targetLanguage,
    timeoutMs: config.ollamaTimeoutMs,
    statusTimeoutMs: config.ollamaStatusTimeoutMs,
    keepAlive: config.ollamaKeepAlive,
    maxInputChars: config.ollamaMaxInputChars,
    maxOutputChars: config.maxTranslationLength,
    maxOutputTokens: config.ollamaMaxOutputTokens,
    repairMinimumConfidence: config.ollamaMinConfidence,
    maxResponseBytes: config.ollamaMaxResponseBytes,
    maxConcurrency: config.ollamaMaxConcurrency,
    queueLimit: config.ollamaQueueLimit,
    circuitFailureThreshold: config.ollamaCircuitFailureThreshold,
    circuitCooldownMs: config.ollamaCircuitCooldownMs,
    cacheMaxEntries: config.translationCacheMaxEntries,
    cacheTtlMs: config.translationCacheTtlMs,
    contextMessageLimit: 0,
    contextMaxChars: 0
  });
  const health = await client.healthCheck();
  if (!health.serviceAvailable || !health.modelAvailable) {
    console.error("Ollama evaluation unavailable: service or configured model is not ready.");
    process.exitCode = 2;
    return;
  }

  const fixturePath = path.join(__dirname, "..", "fixtures", "translation-evaluation.json");
  const corpus = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const result = await evaluateCorpus(corpus, {
    analyze: (entry) => client.analyze(entry),
    minimumConfidence: config.ollamaMinConfidence,
    maxInputChars: config.ollamaMaxInputChars
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Synthetic fixtures: ${result.fixture_count}`);
    console.log(
      `Legacy candidate gate: ${result.legacy_gate.false_positives} false positives, ${result.legacy_gate.false_negatives} false negatives`
    );
    console.log(
      `Ollama active gate: ${result.ollama_active.false_positives} false positives, ${result.ollama_active.false_negatives} false negatives`
    );
    console.log(
      `Accepted translation quality: ${result.ollama_active.translation_successes}/${result.foreign_fixture_count} (${result.translation_success_percent}%)`
    );
    console.log(
      `Legacy false-positive reduction: ${result.false_positive_reduction_percent}%`
    );
    console.log(`Provider errors: ${result.ollama_active.errors}`);
    if (result.ollama_active.errors > 0) {
      console.log(
        `Provider error codes: ${Object.entries(result.ollama_active.error_codes)
          .map(([code, count]) => `${code}=${count}`)
          .join(", ")}`
      );
    }
    if (result.failed_ids.length > 0) {
      console.log(`Synthetic fixture IDs needing review: ${result.failed_ids.join(", ")}`);
    }
  }

  if (result.ollama_active.errors > 0) {
    process.exitCode = 2;
  }
}

main().catch(() => {
  console.error("Ollama evaluation failed without retaining fixture content.");
  process.exitCode = 2;
});
