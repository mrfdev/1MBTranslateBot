function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function escapeBackticks(value) {
  return value.replace(/`/g, "'");
}

function codeBlock(value) {
  return `\`\`\`text\n${String(value).replace(/```/g, "'''")}\n\`\`\``;
}

function formatTranslation(result, options = {}) {
  const maxOriginalLength = options.maxOriginalLength || 240;
  const maxTranslationLength = options.maxTranslationLength || 600;
  const maxTranslationsPerMessage = options.maxTranslationsPerMessage || 1;
  const flag = result.flagged ? ":triangular_flag_on_post: " : "";
  const original = escapeBackticks(truncate(result.original, maxOriginalLength));
  const translations = result.translations
    .slice(0, maxTranslationsPerMessage)
    .map((item) => escapeBackticks(truncate(item, maxTranslationLength)));

  if (translations.length === 0) {
    const formattedOriginal = original.includes("\n") ? `\n${codeBlock(original)}` : ` \`${original}\``;
    const note = result.note ? `\n${result.note}` : "";
    return `${flag}(${result.languageLabel})${formattedOriginal}${note}`;
  }

  const hasMultiline = original.includes("\n") || translations.some((item) => item.includes("\n"));
  if (hasMultiline) {
    return `${flag}(${result.languageLabel})\n${codeBlock(original)}\n==\n${codeBlock(translations.join("\n---\n"))}`;
  }

  return `${flag}(${result.languageLabel}) \`${original}\` == ${translations.map((item) => `\`${item}\``).join(" / ")}`;
}

module.exports = {
  escapeBackticks,
  formatTranslation,
  truncate
};
