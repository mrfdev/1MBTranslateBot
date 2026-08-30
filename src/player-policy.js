function normalizePlayerName(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function createPlayerNameSet(values = []) {
  return new Set(
    values.map(normalizePlayerName).filter(Boolean)
  );
}

function isEntryFromIgnoredPlayer(entry, ignoredPlayerNames) {
  const actor = normalizePlayerName(entry?.actor);
  return Boolean(actor && ignoredPlayerNames?.has(actor));
}

function entryForConversationContext(entry, ignoredPlayerNames) {
  return isEntryFromIgnoredPlayer(entry, ignoredPlayerNames) ? null : entry;
}

function processEntryWithPlayerPolicy(options) {
  const {
    entry,
    context = [],
    ignoredPlayerNames,
    translationService,
    translationOptions = {}
  } = options;

  if (isEntryFromIgnoredPlayer(entry, ignoredPlayerNames)) {
    return translationService.riskOnlyResult(String(entry?.text ?? ""));
  }

  return translationService.translate(entry, context, translationOptions);
}

module.exports = {
  createPlayerNameSet,
  entryForConversationContext,
  isEntryFromIgnoredPlayer,
  normalizePlayerName,
  processEntryWithPlayerPolicy
};
