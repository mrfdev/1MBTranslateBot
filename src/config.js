const dotenv = require("dotenv");
const {
  isLocalOllamaModelName,
  normalizeLoopbackOllamaBaseUrl
} = require("./ollama-translator");
const { createPlayerNameSet } = require("./player-policy");

dotenv.config();

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) {
    throw new Error(`missing-environment-variable:${name}`);
  }
  return value;
}

function booleanValue(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLocaleLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error("invalid-boolean-environment-value");
}

function numberValue(value, fallback, minimum, maximum, integer = false) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
    (integer && !Number.isSafeInteger(parsed))
  ) {
    throw new Error("invalid-number-environment-value");
  }
  return parsed;
}

function csv(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value || fallback).trim().toLocaleLowerCase();
  if (!allowed.includes(normalized)) {
    throw new Error("invalid-environment-enum");
  }
  return normalized;
}

function translationMode(env) {
  if (env.OLLAMA_MODE) {
    return enumValue(env.OLLAMA_MODE, ["off", "shadow", "active"], "active");
  }

  // Compatibility with the unshipped provider draft that may exist in a local .env.
  if (String(env.TRANSLATION_PROVIDER || "").trim().toLocaleLowerCase() === "libretranslate") {
    return "off";
  }
  return "active";
}

function loadTranslationConfig(env = process.env) {
  const mode = translationMode(env);
  const ollamaBaseUrl = normalizeLoopbackOllamaBaseUrl(
    env.OLLAMA_BASE_URL || env.OLLAMA_URL || "http://127.0.0.1:11434"
  );
  if (!ollamaBaseUrl) {
    throw new Error("OLLAMA_BASE_URL-must-be-loopback-http");
  }

  const ollamaModel = String(env.OLLAMA_MODEL || "qwen3:8b").trim();
  if (!isLocalOllamaModelName(ollamaModel)) {
    throw new Error("OLLAMA_MODEL-must-name-a-local-model");
  }

  const libreTranslateUrl = normalizeLoopbackOllamaBaseUrl(
    env.LIBRETRANSLATE_URL || "http://127.0.0.1:5000"
  );
  if (["off", "shadow"].includes(mode) && !libreTranslateUrl) {
    throw new Error("LIBRETRANSLATE_URL-must-be-loopback-http");
  }

  return {
    translationMode: mode,
    targetLanguage: String(env.TARGET_LANG || "en").trim().toLocaleLowerCase(),
    ollamaBaseUrl,
    ollamaModel,
    ollamaTimeoutMs: numberValue(env.OLLAMA_TIMEOUT_MS, 45_000, 1_000, 120_000, true),
    ollamaStatusTimeoutMs: numberValue(
      env.OLLAMA_STATUS_TIMEOUT_MS,
      2_000,
      250,
      10_000,
      true
    ),
    ollamaKeepAlive: String(env.OLLAMA_KEEP_ALIVE || "5m").slice(0, 20),
    ollamaMinConfidence: numberValue(env.OLLAMA_MIN_CONFIDENCE, 0.9, 0, 1),
    ollamaMaxInputChars: numberValue(
      env.OLLAMA_MAX_INPUT_CHARS,
      1_200,
      1,
      20_000,
      true
    ),
    ollamaMaxOutputTokens: numberValue(
      env.OLLAMA_MAX_OUTPUT_TOKENS,
      256,
      32,
      2_048,
      true
    ),
    ollamaMaxResponseBytes: numberValue(
      env.OLLAMA_MAX_RESPONSE_BYTES,
      65_536,
      1_024,
      1_048_576,
      true
    ),
    ollamaMaxConcurrency: numberValue(
      env.OLLAMA_MAX_CONCURRENCY,
      1,
      1,
      32,
      true
    ),
    ollamaQueueLimit: numberValue(env.OLLAMA_QUEUE_LIMIT, 16, 0, 10_000, true),
    ollamaCircuitFailureThreshold: numberValue(
      env.OLLAMA_CIRCUIT_FAILURE_THRESHOLD,
      3,
      1,
      100,
      true
    ),
    ollamaCircuitCooldownMs: numberValue(
      env.OLLAMA_CIRCUIT_COOLDOWN_MS,
      60_000,
      100,
      3_600_000,
      true
    ),
    translationCacheMaxEntries: numberValue(
      env.TRANSLATION_CACHE_MAX_ENTRIES,
      2_000,
      0,
      100_000,
      true
    ),
    translationCacheTtlMs: numberValue(
      env.TRANSLATION_CACHE_TTL_MS,
      21_600_000,
      0,
      604_800_000,
      true
    ),
    libreTranslateUrl,
    libreTranslateApiKey: env.LIBRETRANSLATE_API_KEY || "",
    libreTranslateMaxResponseBytes: numberValue(
      env.LIBRETRANSLATE_MAX_RESPONSE_BYTES,
      65_536,
      1_024,
      1_048_576,
      true
    ),
    translationAlternatives: numberValue(
      env.TRANSLATION_ALTERNATIVES,
      2,
      0,
      10,
      true
    ),
    maxTranslationsPerMessage: numberValue(
      env.MAX_TRANSLATIONS_PER_MESSAGE,
      1,
      1,
      5,
      true
    ),
    minDetectionConfidence: numberValue(env.MIN_DETECTION_CONFIDENCE, 0.5, 0, 1),
    contextLanguageConfidence: numberValue(env.CONTEXT_LANGUAGE_CONFIDENCE, 0.65, 0, 1),
    translationTimeoutMs: numberValue(
      env.TRANSLATION_TIMEOUT_MS,
      12_000,
      500,
      120_000,
      true
    ),
    translationDelayMs: numberValue(env.TRANSLATION_DELAY_MS, 800, 0, 60_000, true),
    contextMaxConversations: numberValue(
      env.CONTEXT_MAX_CONVERSATIONS,
      500,
      0,
      100_000,
      true
    ),
    contextMessageLimit: numberValue(env.CONTEXT_MESSAGE_LIMIT, 5, 1, 20, true),
    contextMaxChars: numberValue(env.CONTEXT_MAX_CHARS, 2_000, 0, 10_000, true),
    contextTtlMs: numberValue(env.CONTEXT_TTL_MS, 600_000, 0, 86_400_000, true),
    maxOriginalLength: numberValue(env.MAX_ORIGINAL_LENGTH, 600, 1, 4_000, true),
    maxTranslationLength: numberValue(
      env.MAX_TRANSLATION_LENGTH,
      600,
      1,
      4_000,
      true
    ),
    enableRiskFlag: booleanValue(env.ENABLE_RISK_FLAG, true),
    extraFlaggedTerms: csv(env.FLAGGED_TERMS),
    metricsIntervalMs: numberValue(
      env.PRIVACY_METRICS_INTERVAL_MS,
      300_000,
      0,
      86_400_000,
      true
    )
  };
}

function loadConfig(env = process.env) {
  const discordToken = required(env, "DISCORD_TOKEN");
  const guildId = required(env, "DISCORD_GUILD_ID");
  const logChannelId = required(env, "LOG_CHANNEL_ID");
  const sourceBotIds = new Set(csv(env.SOURCE_BOT_IDS));
  const sourceWebhookIds = new Set(csv(env.SOURCE_WEBHOOK_IDS));
  const ignoredPlayerNames = createPlayerNameSet(csv(env.IGNORED_PLAYER_NAMES));
  const allowAnySource = booleanValue(env.ALLOW_ANY_SOURCE, false);
  const translateHumanMessages = booleanValue(env.TRANSLATE_HUMAN_MESSAGES, false);
  if (
    sourceBotIds.size === 0 &&
    sourceWebhookIds.size === 0 &&
    !allowAnySource &&
    !translateHumanMessages
  ) {
    throw new Error("missing-trusted-message-source");
  }

  return {
    ...loadTranslationConfig(env),
    discordToken,
    guildId,
    logChannelId,
    signChannelId: String(env.SIGN_CHANNEL_ID || "").trim(),
    bookChannelId: String(env.BOOK_CHANNEL_ID || "").trim(),
    sourceBotIds,
    sourceWebhookIds,
    ignoredPlayerNames,
    allowAnySource,
    translateHumanMessages,
    messageMaxConcurrency: numberValue(
      env.MESSAGE_MAX_CONCURRENCY,
      2,
      1,
      32,
      true
    ),
    messageQueueLimit: numberValue(env.MESSAGE_QUEUE_LIMIT, 100, 0, 10_000, true),
    messageMaxInspectedChars: numberValue(
      env.MESSAGE_MAX_INSPECTED_CHARS,
      100_000,
      1_000,
      1_000_000,
      true
    ),
    messageMaxCandidates: numberValue(
      env.MESSAGE_MAX_CANDIDATES,
      16,
      1,
      64,
      true
    ),
    messageMaxCandidateChars: numberValue(
      env.MESSAGE_MAX_CANDIDATE_CHARS,
      20_000,
      1_000,
      100_000,
      true
    ),
    messageProcessingBudgetMs: numberValue(
      env.MESSAGE_PROCESSING_BUDGET_MS,
      60_000,
      1_000,
      300_000,
      true
    ),
    messageMaxOutputChars: numberValue(
      env.MESSAGE_MAX_OUTPUT_CHARS,
      15_200,
      1_900,
      100_000,
      true
    ),
    messageMaxOutputChunks: numberValue(
      env.MESSAGE_MAX_OUTPUT_CHUNKS,
      8,
      1,
      32,
      true
    ),
    healthSnapshotIntervalMs: numberValue(
      env.HEALTH_SNAPSHOT_INTERVAL_MS,
      30_000,
      5_000,
      300_000,
      true
    )
  };
}

module.exports = {
  booleanValue,
  loadConfig,
  loadTranslationConfig,
  numberValue,
  translationMode
};
