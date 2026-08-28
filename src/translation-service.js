const { looksProbablyEnglish } = require("./language");
const { OllamaError } = require("./ollama-translator");
const { shouldFlagText } = require("./safety");
const { languageName } = require("./translator");

const MODES = new Set(["off", "shadow", "active"]);
const COMMON_GAME_TERMS = new Set([
  "afk",
  "bedrock",
  "biome",
  "cmi",
  "cobble",
  "crafting",
  "discord",
  "elytra",
  "enchanting",
  "enderman",
  "grief",
  "mcMMO".toLowerCase(),
  "minecraft",
  "mob",
  "nether",
  "netherite",
  "plugin",
  "redstone",
  "respawn",
  "server",
  "shop",
  "spawn",
  "spawner",
  "teleport",
  "villager",
  "warp"
]);

function normalizeComparable(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function hasMeaningfulTranslation(original, translations) {
  if (!Array.isArray(translations) || translations.length === 0) {
    return false;
  }
  const normalizedOriginal = normalizeComparable(original);
  return translations.some(
    (translation) => normalizeComparable(translation) !== normalizedOriginal
  );
}

function localLeaveUnchangedReason(text, maxInputChars = 1_200) {
  const value = String(text ?? "").normalize("NFC");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxInputChars) {
    return "nonlinguistic";
  }
  if (!/\p{L}/u.test(trimmed)) {
    return "nonlinguistic";
  }
  if (
    /^(?:https?:\/\/\S+|www\.\S+|\/[a-z][\w:-]*(?:\s+[\w:.-]+){0,2}|(?:[xyz]:?\s*-?\d+(?:\s+|,\s*)){1,2}[xyz]:?\s*-?\d+)$/iu.test(
      trimmed
    )
  ) {
    return "nonlinguistic";
  }
  if (!/\s/u.test(trimmed) && /[_]/u.test(trimmed) && /\d/u.test(trimmed)) {
    return "nonlinguistic";
  }
  const hasProtectedFormatting =
    /%[A-Z0-9_.:-]+%|§[0-9A-FK-ORX]|&(?:#[0-9A-F]{6}|[0-9A-FK-OR])|(?:^|\s)\/[A-Z][A-Z0-9_:-]*/iu.test(
      trimmed
    );
  if (looksProbablyEnglish(trimmed) && !hasProtectedFormatting) {
    return "english";
  }

  const words = trimmed.match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu) || [];
  if (words.length === 1) {
    const word = words[0].toLocaleLowerCase();
    const latinOnly = /^[\p{Script=Latin}\p{M}'’]+$/u.test(words[0]);
    if (
      (latinOnly && word.length <= 24) ||
      (!latinOnly && [...word].length <= 3) ||
      COMMON_GAME_TERMS.has(word) ||
      /^[A-Z][\p{L}\p{M}\d_]{1,23}$/u.test(words[0])
    ) {
      return COMMON_GAME_TERMS.has(word) ? "proper_noun" : "too_short";
    }
  }

  return null;
}

function recentLanguageHint(context, actor, minimumConfidence, targetLanguage) {
  const normalizedActor = String(actor || "").trim().toLocaleLowerCase();
  const candidates = normalizedActor
    ? context.filter(
        (entry) =>
          String(entry?.speaker || "").trim().toLocaleLowerCase() === normalizedActor
      )
    : context;

  for (const entry of [...candidates].reverse()) {
    if (
      entry?.language &&
      !["auto", "unknown", "und", targetLanguage].includes(entry.language) &&
      Number(entry.confidence) >= minimumConfidence
    ) {
      return entry.language;
    }
  }
  return null;
}

function safeErrorCode(error) {
  if (error instanceof OllamaError && error.code) {
    return error.code;
  }
  if (typeof error?.code === "string" && /^[a-z0-9-]{1,80}$/iu.test(error.code)) {
    return error.code.toLocaleLowerCase();
  }
  return "unexpected-error";
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

class TranslationService {
  constructor(options = {}) {
    this.mode = String(options.mode || "active").trim().toLocaleLowerCase();
    if (!MODES.has(this.mode)) {
      throw new Error("invalid-translation-mode");
    }
    this.ollama = options.ollama || null;
    this.legacy = options.legacy || null;
    this.targetLanguage = String(options.targetLanguage || "en").trim().toLocaleLowerCase();
    this.minimumConfidence = Math.max(
      0,
      Math.min(1, finiteOr(options.minimumConfidence, 0.9))
    );
    this.minimumDetectionConfidence = Math.max(
      0,
      Math.min(1, finiteOr(options.minimumDetectionConfidence, 0.5))
    );
    this.contextLanguageConfidence = Math.max(
      0,
      Math.min(1, finiteOr(options.contextLanguageConfidence, 0.65))
    );
    this.maxInputChars = Math.max(1, finiteOr(options.maxInputChars, 1_200));
    this.maxTranslations = Math.max(1, finiteOr(options.maxTranslations, 1));
    this.enableRiskFlag = options.enableRiskFlag !== false;
    this.extraFlaggedTerms = Array.isArray(options.extraFlaggedTerms)
      ? options.extraFlaggedTerms
      : [];
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.shadowTasks = new Set();
    this.metrics = {
      active_translations: 0,
      active_unchanged: 0,
      local_short_circuits: 0,
      failures: 0,
      shadow_started: 0,
      shadow_completed: 0,
      shadow_failures: 0
    };

    if (["active", "shadow"].includes(this.mode) && !this.ollama) {
      throw new Error("ollama-required");
    }
    if (["off", "shadow"].includes(this.mode) && !this.legacy) {
      throw new Error("legacy-translator-required");
    }
  }

  metricsSnapshot() {
    return {
      ...this.metrics,
      ollama: this.ollama?.metricsSnapshot?.() || null
    };
  }

  async drainShadow() {
    await Promise.allSettled([...this.shadowTasks]);
  }

  riskOnlyResult(original, language = "und", confidence = 1) {
    if (
      !this.enableRiskFlag ||
      !shouldFlagText({
        original,
        translated: "",
        extraTerms: this.extraFlaggedTerms
      })
    ) {
      return null;
    }

    return {
      original,
      translations: [],
      language,
      languageLabel: language === "en" ? "English" : languageName(language),
      confidence,
      flagged: true,
      note: "flagged for staff review"
    };
  }

  async translate(entry, context = []) {
    if (this.mode === "active") {
      return this.translateWithOllama(entry, context);
    }
    if (this.mode === "shadow") {
      this.startShadow(entry, context);
    }
    return this.translateLegacy(entry, context);
  }

  startShadow(entry, context) {
    this.metrics.shadow_started += 1;
    const task = this.translateWithOllama(entry, context, { shadow: true })
      .then(() => {
        this.metrics.shadow_completed += 1;
      })
      .catch(() => {
        this.metrics.shadow_failures += 1;
      })
      .finally(() => {
        this.shadowTasks.delete(task);
      });
    this.shadowTasks.add(task);
  }

  async translateWithOllama(entry, context, options = {}) {
    const original = String(entry?.text ?? "");
    const localReason = localLeaveUnchangedReason(original, this.maxInputChars);
    if (localReason) {
      this.metrics.local_short_circuits += 1;
      this.metrics.active_unchanged += options.shadow ? 0 : 1;
      this.onEvent({ event: "ollama.local-decision", decision: "leave_unchanged", reason: localReason });
      return this.riskOnlyResult(original, localReason === "english" ? "en" : "und");
    }

    let decision;
    try {
      decision = await this.ollama.analyze(entry, context);
    } catch (error) {
      this.metrics.failures += 1;
      this.onEvent({ event: "ollama.failure", code: safeErrorCode(error) });
      return this.riskOnlyResult(original);
    }

    this.onEvent({
      event: "ollama.decision",
      decision: decision.decision,
      reason: decision.reason_code,
      accepted:
        decision.decision === "translate" &&
        decision.confidence >= this.minimumConfidence
    });
    if (
      decision.decision !== "translate" ||
      decision.source_language === this.targetLanguage ||
      decision.confidence < this.minimumConfidence ||
      !decision.translation
    ) {
      this.metrics.active_unchanged += options.shadow ? 0 : 1;
      return this.riskOnlyResult(
        original,
        decision.source_language,
        decision.confidence
      );
    }

    const translations = [decision.translation];
    if (!hasMeaningfulTranslation(original, translations)) {
      this.metrics.active_unchanged += options.shadow ? 0 : 1;
      return this.riskOnlyResult(original, decision.source_language, decision.confidence);
    }

    this.metrics.active_translations += options.shadow ? 0 : 1;
    return {
      original,
      translations,
      language: decision.source_language,
      languageLabel: languageName(decision.source_language),
      confidence: decision.confidence,
      flagged:
        this.enableRiskFlag &&
        shouldFlagText({
          original,
          translated: translations.join("\n"),
          extraTerms: this.extraFlaggedTerms
        })
    };
  }

  async translateLegacy(entry, context) {
    const original = String(entry?.text ?? "");
    if (looksProbablyEnglish(original)) {
      return this.riskOnlyResult(original, "en");
    }

    const detected = await this.legacy.detect(original);
    if (
      detected.language === this.targetLanguage &&
      detected.confidence >= this.minimumDetectionConfidence
    ) {
      return this.riskOnlyResult(original, this.targetLanguage, detected.confidence);
    }

    const sourceLanguage =
      detected.confidence >= this.minimumDetectionConfidence
        ? detected.language
        : recentLanguageHint(
            context,
            entry?.actor,
            this.contextLanguageConfidence,
            this.targetLanguage
          ) || "auto";
    const translations = (await this.legacy.translate(original, sourceLanguage)).slice(
      0,
      this.maxTranslations
    );
    if (!hasMeaningfulTranslation(original, translations)) {
      return this.riskOnlyResult(original, detected.language, detected.confidence);
    }

    return {
      original,
      translations,
      language: sourceLanguage === "auto" ? detected.language : sourceLanguage,
      languageLabel:
        sourceLanguage === "auto" ? "Unknown" : languageName(sourceLanguage),
      confidence: detected.confidence,
      flagged:
        this.enableRiskFlag &&
        shouldFlagText({
          original,
          translated: translations.join("\n"),
          extraTerms: this.extraFlaggedTerms
        })
    };
  }
}

module.exports = {
  TranslationService,
  hasMeaningfulTranslation,
  localLeaveUnchangedReason,
  normalizeComparable,
  safeErrorCode
};
