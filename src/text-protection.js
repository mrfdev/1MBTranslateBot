class TextProtectionError extends Error {
  constructor(code) {
    super(code);
    this.name = "TextProtectionError";
    this.code = code;
  }
}

// These tokens are data, not language. They must survive translation byte-for-byte.
// The order matters: broader markup patterns come after Discord-specific forms.
const PROTECTED_PATTERN = new RegExp(
  [
    "https?:\\/\\/[^\\s<>()]+",
    "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}",
    "\\/[A-Z][A-Z0-9_:-]*(?:[ \\t]+[A-Z0-9_.:-]+)?",
    "<a?:[A-Z0-9_]{1,32}:\\d{2,}>",
    "<(?:@!?|@&|#)\\d{2,}>",
    "<\\/?[A-Z][^<>\\r\\n]{0,120}>",
    "§x(?:§[0-9A-F]){6}",
    "§[0-9A-FK-OR]",
    "&(?:#[0-9A-F]{6}|[0-9A-FK-OR])",
    "%[A-Z0-9_.:-]+%",
    "\\{\\{[^{}\\r\\n]{1,100}\\}\\}",
    "\\$\\{[^{}\\r\\n]{1,100}\\}",
    "\\{[A-Z0-9_.:-]+\\}",
    "`{1,3}",
    "^[ \\t]+",
    "[ \\t]+$",
    "[ \\t]{2,}",
    "\\r\\n|\\r|\\n",
    "[!?！？。…]+",
    "[.,:;，。：；]+(?=\\s|$)",
    "[()\\[\\]\"\u201c\u201d\u00ab\u00bb]"
  ].join("|"),
  "gimu"
);

const UNSAFE_GENERATED_PATTERN = new RegExp(
  [
    "https?:\\/\\/",
    "\\bwww\\.",
    "\\bdiscord\\.gg\\/",
    "<a?:[A-Z0-9_]{1,32}:\\d{2,}>",
    "<(?:@!?|@&|#)\\d{2,}>",
    "@",
    "^[ \\t]*\\/[A-Z][A-Z0-9_:-]*",
    "```",
    "\\*\\*|__|~~|\\|\\|",
    "\\[[^\\]]+\\]\\([^)]+\\)",
    "<\\/?[A-Z][^<>\\r\\n]{0,120}>"
  ].join("|"),
  "iu"
);

function markerPrefix(text) {
  let attempt = 0;
  while (attempt < 10_000) {
    const prefix = `[[KEEP_${attempt}_`;
    if (!text.includes(prefix)) {
      return prefix;
    }
    attempt += 1;
  }

  throw new TextProtectionError("marker-collision");
}

function markerDescription(value) {
  const categories = [];
  if (/\r|\n/u.test(value)) categories.push("LINE_BREAK");
  if (/[ \t]{2,}|^[ \t]+$|^\t+$/u.test(value)) categories.push("WHITESPACE");
  if (/https?:\/\//iu.test(value)) categories.push("URL");
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value)) categories.push("EMAIL");
  if (/(?:^|\s)\/[A-Z][A-Z0-9_:-]*/iu.test(value)) categories.push("COMMAND");
  if (/%[A-Z0-9_.:-]+%|\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[A-Z0-9_.:-]+\}/iu.test(value)) {
    categories.push("PLACEHOLDER");
  }
  if (/§[0-9A-FK-ORX]|&(?:#[0-9A-F]{6}|[0-9A-FK-OR])/iu.test(value)) {
    categories.push("MINECRAFT_FORMAT");
  }
  if (/<(?:@!?|@&|#)\d+>|<a?:[A-Z0-9_]+:\d+>/iu.test(value)) {
    categories.push("DISCORD_TOKEN");
  }
  if (/<\/?[A-Z][^<>]*>/iu.test(value)) categories.push("FORMAT_TAG");
  if (/`|\*\*|__|~~|\|\|/u.test(value)) categories.push("MARKDOWN");
  if (/\p{P}|\p{S}/u.test(value)) categories.push("PUNCTUATION");
  return [...new Set(categories)].join("_") || "FORMAT";
}

function protectText(value) {
  const original = String(value ?? "").normalize("NFC");
  const prefix = markerPrefix(original);
  const tokens = [];
  const pieces = [];
  let cursor = 0;
  PROTECTED_PATTERN.lastIndex = 0;
  for (const match of original.matchAll(PROTECTED_PATTERN)) {
    const index = match.index;
    const matched = match[0];
    pieces.push(original.slice(cursor, index));
    const previous = tokens.at(-1);
    if (previous && index === cursor) {
      previous.value += matched;
      const replacement = `${prefix}${tokens.length - 1}:${markerDescription(previous.value)}]]`;
      for (let pieceIndex = pieces.length - 1; pieceIndex >= 0; pieceIndex -= 1) {
        if (pieces[pieceIndex] === previous.marker) {
          pieces[pieceIndex] = replacement;
          break;
        }
      }
      previous.marker = replacement;
    } else {
      const marker = `${prefix}${tokens.length}:${markerDescription(matched)}]]`;
      tokens.push({ marker, value: matched });
      pieces.push(marker);
    }
    cursor = index + matched.length;
  }
  pieces.push(original.slice(cursor));
  const templateText = pieces.join("");
  let text = templateText;
  const firstToken = tokens[0];
  if (firstToken && text.startsWith(firstToken.marker)) {
    text = text.slice(firstToken.marker.length);
  }
  const lastToken = tokens.at(-1);
  if (lastToken && text.endsWith(lastToken.marker)) {
    text = text.slice(0, -lastToken.marker.length);
  }

  return { original, text, templateText, prefix, tokens };
}

function countOccurrences(text, needle) {
  if (!needle) {
    return 0;
  }

  return text.split(needle).length - 1;
}

function restoreProtectedText(value, protection, options = {}) {
  let translated = String(value ?? "");
  const maxOutputChars = Math.max(1, Number(options.maxOutputChars) || 1_200);

  if (!translated || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(translated)) {
    throw new TextProtectionError("unsafe-output");
  }
  if (translated.includes("\r") || translated.includes("\n")) {
    throw new TextProtectionError("line-break-mismatch");
  }
  if (UNSAFE_GENERATED_PATTERN.test(translated)) {
    throw new TextProtectionError("formatting-injection");
  }

  const firstToken = protection.tokens[0];
  const templateText = protection.templateText || protection.text;
  if (
    firstToken &&
    templateText.startsWith(firstToken.marker) &&
    countOccurrences(translated, firstToken.marker) === 0
  ) {
    if (/^[ \t]+$/u.test(firstToken.value)) {
      translated = translated.replace(/^[ \t]+/u, "");
    }
    const followingWhitespace =
      templateText.slice(firstToken.marker.length).match(/^[ \t]+/u)?.[0] || "";
    translated = `${firstToken.marker}${followingWhitespace}${translated.replace(/^[ \t]+/u, "")}`;
  }
  const lastToken = protection.tokens.at(-1);
  if (
    lastToken &&
    templateText.endsWith(lastToken.marker) &&
    countOccurrences(translated, lastToken.marker) === 0
  ) {
    if (/^[ \t]+$/u.test(lastToken.value)) {
      translated = translated.replace(/[ \t]+$/u, "");
    }
    const precedingWhitespace =
      templateText.slice(0, -lastToken.marker.length).match(/[ \t]+$/u)?.[0] || "";
    translated = `${translated.replace(/[ \t]+$/u, "")}${precedingWhitespace}${lastToken.marker}`;
  }

  let previousIndex = -1;
  for (const token of protection.tokens) {
    const index = translated.indexOf(token.marker);
    if (
      index < 0 ||
      index <= previousIndex ||
      countOccurrences(translated, token.marker) !== 1
    ) {
      throw new TextProtectionError("protected-token-mismatch");
    }
    previousIndex = index;
  }

  translated = matchInitialCapitalization(
    protection.text,
    translated,
    protection.tokens.map((token) => token.marker)
  );

  for (const token of protection.tokens) {
    translated = translated.replace(token.marker, token.value);
  }

  if (translated.includes(protection.prefix)) {
    throw new TextProtectionError("unexpected-protected-token");
  }
  if (translated.length > maxOutputChars) {
    throw new TextProtectionError("output-too-long");
  }

  const originalLines = protection.original.split(/\r\n|\r|\n/u);
  const translatedLines = translated.split(/\r\n|\r|\n/u);
  if (originalLines.length !== translatedLines.length) {
    throw new TextProtectionError("line-break-mismatch");
  }
  for (let index = 0; index < translatedLines.length; index += 1) {
    const originalStartsWithCommand = /^\s*\/[A-Za-z][\w:-]*/u.test(originalLines[index]);
    const translatedStartsWithCommand = /^\s*\/[A-Za-z][\w:-]*/u.test(translatedLines[index]);
    if (translatedStartsWithCommand && !originalStartsWithCommand) {
      throw new TextProtectionError("command-injection");
    }
  }

  return translated;
}

function matchInitialCapitalization(original, translated, markers = []) {
  let sourceForMatching = String(original);
  let translatedForMatching = String(translated);
  for (const marker of markers) {
    sourceForMatching = sourceForMatching.replaceAll(marker, " ".repeat(marker.length));
    translatedForMatching = translatedForMatching.replaceAll(marker, " ".repeat(marker.length));
  }
  const originalMatch = sourceForMatching.match(/\p{L}/u);
  const translatedMatch = translatedForMatching.match(/\p{L}/u);
  if (!originalMatch || !translatedMatch) {
    return translated;
  }

  const originalLetter = originalMatch[0];
  const translatedLetter = translatedMatch[0];
  const originalWasUpper =
    originalLetter === originalLetter.toLocaleUpperCase() &&
    originalLetter !== originalLetter.toLocaleLowerCase();
  const replacement = originalWasUpper
    ? translatedLetter.toLocaleUpperCase()
    : translatedLetter.toLocaleLowerCase();
  if (replacement === translatedLetter) {
    return translated;
  }

  const index = translatedMatch.index;
  return `${translated.slice(0, index)}${replacement}${translated.slice(index + translatedLetter.length)}`;
}

function neutralizeDiscordMentions(value) {
  return String(value ?? "").replace(/@/gu, "@\u200b");
}

module.exports = {
  TextProtectionError,
  neutralizeDiscordMentions,
  protectText,
  restoreProtectedText
};
