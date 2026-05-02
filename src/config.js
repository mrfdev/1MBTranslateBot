const dotenv = require("dotenv");

dotenv.config();

function toBoolean(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function toNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function splitCsv(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function loadConfig() {
  return {
    discordToken: required("DISCORD_TOKEN"),
    guildId: process.env.DISCORD_GUILD_ID || "487398800353263616",
    logChannelId: process.env.LOG_CHANNEL_ID || "807177293943275530",
    sourceBotIds: new Set(splitCsv(process.env.SOURCE_BOT_IDS)),
    translateHumanMessages: toBoolean(process.env.TRANSLATE_HUMAN_MESSAGES, false),
    libreTranslateUrl: (process.env.LIBRETRANSLATE_URL || "http://127.0.0.1:5000").replace(/\/+$/, ""),
    libreTranslateApiKey: process.env.LIBRETRANSLATE_API_KEY || "",
    targetLanguage: process.env.TARGET_LANG || "en",
    translationAlternatives: toNumber(process.env.TRANSLATION_ALTERNATIVES, 2),
    maxTranslationsPerMessage: Math.max(1, toNumber(process.env.MAX_TRANSLATIONS_PER_MESSAGE, 1)),
    minDetectionConfidence: toNumber(process.env.MIN_DETECTION_CONFIDENCE, 0.2),
    translationTimeoutMs: toNumber(process.env.TRANSLATION_TIMEOUT_MS, 12000),
    translationDelayMs: toNumber(process.env.TRANSLATION_DELAY_MS, 800),
    maxOriginalLength: toNumber(process.env.MAX_ORIGINAL_LENGTH, 240),
    enableRiskFlag: toBoolean(process.env.ENABLE_RISK_FLAG, true),
    extraFlaggedTerms: splitCsv(process.env.FLAGGED_TERMS)
  };
}

module.exports = {
  loadConfig
};
