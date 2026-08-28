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
  "book",
  "but",
  "can",
  "claim",
  "cobble",
  "come",
  "diamond",
  "do",
  "does",
  "dont",
  "english",
  "fish",
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
  "iron",
  "is",
  "it",
  "just",
  "like",
  "me",
  "mayor",
  "my",
  "myths",
  "no",
  "not",
  "now",
  "of",
  "ok",
  "on",
  "one",
  "or",
  "please",
  "plats",
  "player",
  "plots",
  "so",
  "server",
  "shop",
  "smaller",
  "sword",
  "that",
  "the",
  "then",
  "there",
  "this",
  "to",
  "totem",
  "town",
  "up",
  "we",
  "what",
  "warp",
  "when",
  "where",
  "why",
  "will",
  "with",
  "yes",
  "you",
  "your"
]);

const STRONG_SHORT_ENGLISH_WORDS = new Set([
  "bye",
  "hello",
  "help",
  "hey",
  "hi",
  "nope",
  "ok",
  "okay",
  "please",
  "sorry",
  "thanks",
  "welcome",
  "yes"
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

  // Emoji and curly punctuation do not make an otherwise English message foreign.
  // Non-ASCII letters still indicate that local detection should defer to a provider.
  if ([...value].some((character) => character.codePointAt(0) > 127 && /\p{L}/u.test(character))) {
    return false;
  }

  const tokens = tokenize(value).filter((token) => token.length > 1 || token === "i" || token === "a");
  if (tokens.length === 0) {
    return false;
  }

  const commonHits = tokens.filter((token) => COMMON_ENGLISH_WORDS.has(token)).length;
  const uniqueCommonHits = new Set(tokens.filter((token) => COMMON_ENGLISH_WORDS.has(token))).size;
  const ratio = commonHits / tokens.length;

  if (tokens.length === 1) {
    return STRONG_SHORT_ENGLISH_WORDS.has(tokens[0]);
  }

  if (tokens.length === 2) {
    return (
      tokens.every(
        (token) => COMMON_ENGLISH_WORDS.has(token) || STRONG_SHORT_ENGLISH_WORDS.has(token)
      ) && tokens.some((token) => STRONG_SHORT_ENGLISH_WORDS.has(token))
    );
  }

  if (tokens.includes("english") && uniqueCommonHits >= 2) {
    return true;
  }

  if (tokens.length <= 4 && ratio === 1) {
    return true;
  }

  return uniqueCommonHits >= 3 && ratio >= 0.3;
}

module.exports = {
  looksProbablyEnglish
};
