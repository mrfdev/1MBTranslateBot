function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function escapeBackticks(value) {
  return neutralizeDiscordMentions(value).replace(/`/g, "'");
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

function formatTranslation(result, options = {}) {
  const maxOriginalLength = options.maxOriginalLength || 240;
  const maxTranslationLength = options.maxTranslationLength || 600;
  const maxTranslationsPerMessage = options.maxTranslationsPerMessage || 1;
  const flag = result.flagged ? ":triangular_flag_on_post: " : "";
  const note = formatNote(result.note);
  const original = escapeBackticks(truncate(result.original, maxOriginalLength));
  const translations = result.translations
    .slice(0, maxTranslationsPerMessage)
    .map((item) => escapeBackticks(truncate(item, maxTranslationLength)));

  if (translations.length === 0) {
    const formattedOriginal = original.includes("\n") ? `\n${codeBlock(original)}` : ` \`${original}\``;
    return `${flag}(${result.languageLabel})${formattedOriginal}${note}`;
  }

  const hasMultiline = original.includes("\n") || translations.some((item) => item.includes("\n"));
  if (hasMultiline) {
    return `${flag}(${result.languageLabel})\n${codeBlock(original)}\n==\n${codeBlock(translations.join("\n---\n"))}${note}`;
  }

  return `${flag}(${result.languageLabel}) \`${original}\` == ${translations.map((item) => `\`${item}\``).join(" / ")}${note}`;
}

module.exports = {
  escapeBackticks,
  formatNote,
  formatTranslation,
  truncate
};
const { neutralizeDiscordMentions } = require("./text-protection");
