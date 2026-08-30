const { neutralizeDiscordMentions } = require("./text-protection");

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function escapeBackticks(value) {
  return neutralizeDiscordMentions(value).replace(/`/g, "'");
}

function escapeHeading(value, maxLength = 80) {
  return neutralizeDiscordMentions(String(value || ""))
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength)
    .replace(/https?:\/\//giu, (match) => match.replace("://", ":\u200b//"))
    .replace(/\bwww\./giu, (match) => `${match.slice(0, -1)}\u200b.`)
    .replace(/[\\`*_~|>\[\]()]/gu, (character) => `\\${character}`);
}

function codeBlock(value) {
  return `\`\`\`text\n${String(value).replace(/```/g, "'''")}\n\`\`\``;
}

function formatNote(value, maxLength = 240) {
  const note = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!note) {
    return "";
  }

  return `\nReview: \`${escapeBackticks(truncate(note, maxLength))}\``;
}

function providerLabel(value) {
  if (value === "local-ai") {
    return "Local AI";
  }
  if (value === "local-dictionary") {
    return "Local dictionary";
  }
  return "";
}

function formatTranslation(result, options = {}) {
  const maxOriginalLength = options.maxOriginalLength || 240;
  const maxTranslationLength = options.maxTranslationLength || 600;
  const maxTranslationsPerMessage = options.maxTranslationsPerMessage || 1;
  const flag = result.flagged ? ":triangular_flag_on_post: " : "";
  const note = formatNote(result.note);
  const heading = [result.languageLabel, providerLabel(result.provider)]
    .map((item) => escapeHeading(item))
    .filter(Boolean)
    .join(" • ");
  const original = escapeBackticks(truncate(result.original, maxOriginalLength));
  const translations = result.translations
    .slice(0, maxTranslationsPerMessage)
    .map((item) => escapeBackticks(truncate(item, maxTranslationLength)));

  if (translations.length === 0) {
    const formattedOriginal = original.includes("\n") ? `\n${codeBlock(original)}` : ` \`${original}\``;
    return `${flag}(${heading})${formattedOriginal}${note}`;
  }

  const hasMultiline = original.includes("\n") || translations.some((item) => item.includes("\n"));
  if (hasMultiline) {
    return `${flag}(${heading})\n${codeBlock(original)}\n==\n${codeBlock(translations.join("\n---\n"))}${note}`;
  }

  return `${flag}(${heading}) \`${original}\` == ${translations.map((item) => `\`${item}\``).join(" / ")}${note}`;
}

module.exports = {
  escapeBackticks,
  escapeHeading,
  formatNote,
  formatTranslation,
  providerLabel,
  truncate
};
