const DEFAULT_FLAG_PATTERNS = [
  /\b(?:kys|kill\s+yourself|suicide|rape|rapist)\b/i,
  /\b(?:nazi|hitler|heil\s+hitler)\b/i,
  /\b(?:fuck|fucking|shit|shitter|bitch|cunt|asshole|dickhead)\b/i,
  /(?<![\p{L}\p{N}_])(?:kurwa|pierdol\p{L}*|jebac|jeba[cć]|chuj|suka|blyat|блять|сука|хуй)(?![\p{L}\p{N}_])/iu,
  /\b(?:kanker|tering|kut|lul|hoer)\b/i
];

const CRITICAL_RISK_PATTERNS = [
  /(?:^|[.!?]\s*)(?:go\s+|you\s+should\s+)?(?:kys|kill\s+yourself)(?:[.!?]|$)/i,
  /\bi(?:'m| am|'ll| will)\s+(?:going\s+to\s+)?(?:kill|hurt|doxx)\s+you\b/i
];

const CONTEXTUAL_REVIEW_PATTERNS = [
  /\b(?:i(?:'m| am|'ll| will)?\s+(?:going\s+to\s+)?find\s+you|watch\s+your\s+back|(?:kill|hurt|doxx)\s+you|you(?:'re| are)\s+dead)\b/i
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUnicodeWord(character) {
  return /[\p{L}\p{N}_]/u.test(character || "");
}

function buildExtraPatterns(terms) {
  return terms.map((term) => {
    const characters = [...term];
    const prefix = isUnicodeWord(characters[0]) ? "(?<![\\p{L}\\p{N}_])" : "";
    const suffix = isUnicodeWord(characters.at(-1)) ? "(?![\\p{L}\\p{N}_])" : "";
    return new RegExp(`${prefix}${escapeRegex(term)}${suffix}`, "iu");
  });
}

function shouldFlagExtraTerms({ original, translated, extraTerms = [] }) {
  const combined = `${original || ""}\n${translated || ""}`;
  return buildExtraPatterns(extraTerms).some((pattern) => pattern.test(combined));
}

function shouldFlagCriticalRisk({ original, translated }) {
  const combined = `${original || ""}\n${translated || ""}`;
  return CRITICAL_RISK_PATTERNS.some((pattern) => pattern.test(combined));
}

function shouldFlagReviewCandidate({ original, translated, extraTerms = [] }) {
  const combined = `${original || ""}\n${translated || ""}`;
  return (
    shouldFlagCriticalRisk({ original, translated }) ||
    DEFAULT_FLAG_PATTERNS.some((pattern) => pattern.test(combined)) ||
    CONTEXTUAL_REVIEW_PATTERNS.some((pattern) => pattern.test(combined)) ||
    shouldFlagExtraTerms({ original, translated, extraTerms })
  );
}

function shouldFlagText({ original, translated, extraTerms = [] }) {
  const combined = `${original || ""}\n${translated || ""}`;
  const patterns = [...DEFAULT_FLAG_PATTERNS, ...buildExtraPatterns(extraTerms)];
  return patterns.some((pattern) => pattern.test(combined));
}

module.exports = {
  shouldFlagCriticalRisk,
  shouldFlagExtraTerms,
  shouldFlagReviewCandidate,
  shouldFlagText
};
