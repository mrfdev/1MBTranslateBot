const COMMON_ENGLISH_WORDS = new Set([
  "a",
  "about",
  "all",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "but",
  "can",
  "come",
  "do",
  "does",
  "dont",
  "english",
  "for",
  "from",
  "get",
  "go",
  "good",
  "got",
  "have",
  "hello",
  "help",
  "here",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "just",
  "like",
  "me",
  "my",
  "no",
  "not",
  "now",
  "of",
  "ok",
  "on",
  "one",
  "or",
  "please",
  "so",
  "that",
  "the",
  "then",
  "there",
  "this",
  "to",
  "up",
  "we",
  "what",
  "when",
  "where",
  "why",
  "will",
  "with",
  "yes",
  "you",
  "your"
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .match(/[a-z]+/g) || [];
}

function looksProbablyEnglish(text) {
  const value = String(text || "").trim();
  if (!value) {
    return false;
  }

  if (/[^ -~\n\t]/.test(value)) {
    return false;
  }

  const tokens = tokenize(value).filter((token) => token.length > 1 || token === "i" || token === "a");
  if (tokens.length < 3) {
    return false;
  }

  const commonHits = tokens.filter((token) => COMMON_ENGLISH_WORDS.has(token)).length;
  const uniqueCommonHits = new Set(tokens.filter((token) => COMMON_ENGLISH_WORDS.has(token))).size;
  const ratio = commonHits / tokens.length;

  if (tokens.includes("english") && uniqueCommonHits >= 2) {
    return true;
  }

  return uniqueCommonHits >= 3 && ratio >= 0.3;
}

module.exports = {
  looksProbablyEnglish
};
