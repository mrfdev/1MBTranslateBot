#!/usr/bin/env node

const { loadTranslationConfig } = require("../src/config");
const { OllamaTranslateClient } = require("../src/ollama-translator");

async function main() {
  const config = loadTranslationConfig();
  const client = new OllamaTranslateClient({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
    statusTimeoutMs: config.ollamaStatusTimeoutMs,
    maxResponseBytes: config.ollamaMaxResponseBytes,
    cacheMaxEntries: 0,
    cacheTtlMs: 0
  });
  const health = await client.healthCheck();
  console.log(`Ollama service: ${health.serviceAvailable ? "available" : "unavailable"}`);
  console.log(`Configured model: ${health.modelAvailable ? "available" : "unavailable"}`);
  if (!health.serviceAvailable) {
    process.exitCode = 3;
  } else if (!health.modelAvailable) {
    process.exitCode = 2;
  }
}

main().catch(() => {
  console.log("Ollama service: unavailable");
  console.log("Configured model: unavailable");
  process.exitCode = 3;
});
