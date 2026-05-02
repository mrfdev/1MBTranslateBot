const DEFAULT_FLAG_PATTERNS = [
  /\b(?:kys|kill\s+yourself|suicide|rape|rapist)\b/i,
  /\b(?:nazi|hitler|heil\s+hitler)\b/i,
  /\b(?:fuck|fucking|shit|shitter|bitch|cunt|asshole|dickhead)\b/i,
  /\b(?:kurwa|pierdol\w*|jebac|jeba[cć]|chuj|suka|blyat|блять|сука|хуй)\b/i,
  /\b(?:kanker|tering|kut|lul|hoer)\b/i
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExtraPatterns(terms) {
  return terms.map((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "i"));
}

function shouldFlagText({ original, translated, extraTerms = [] }) {
  const combined = `${original || ""}\n${translated || ""}`;
  const patterns = [...DEFAULT_FLAG_PATTERNS, ...buildExtraPatterns(extraTerms)];
  return patterns.some((pattern) => pattern.test(combined));
}

module.exports = {
  shouldFlagText
};
