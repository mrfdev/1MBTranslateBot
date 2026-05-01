function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function stripMinecraftFormatting(value) {
  return value
    .replace(/§[0-9A-FK-OR]/gi, "")
    .replace(/&[0-9A-FK-OR]/gi, "")
    .trim();
}

function collectEmbedText(embed) {
  const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
  const parts = [];

  if (data.description) {
    parts.push(data.description);
  }

  if (Array.isArray(data.fields)) {
    for (const field of data.fields) {
      if (field.value) {
        parts.push(field.value);
      }
    }
  }

  return parts;
}

function collectMessageTextParts(message) {
  const parts = [];

  if (message.content) {
    parts.push(message.content);
  }

  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      parts.push(...collectEmbedText(embed));
    }
  }

  return parts;
}

function extractMarkedCode(raw) {
  const samples = [];
  const fencedPattern = /```(?:\w+)?\n?([\s\S]*?)```/g;
  const inlinePattern = /`([^`\n]+)`/g;

  for (const match of raw.matchAll(fencedPattern)) {
    samples.push(match[1]);
  }

  for (const match of raw.matchAll(inlinePattern)) {
    samples.push(match[1]);
  }

  return samples;
}

function removeDiscordMarkdown(value) {
  return value
    .replace(/^>+\s?/gm, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/~~/g, "")
    .trim();
}

function extractTextFromCommand(line) {
  const cleaned = stripMinecraftFormatting(removeDiscordMarkdown(normalizeText(line)));
  if (!cleaned) {
    return null;
  }

  const directMessageMatch = cleaned.match(
    /(?:^|\s)\/(?:cmi\s+)?(?:msg|message|tell|w|whisper|m|pm)\s+\S+\s+([\s\S]+)$/i
  );
  if (directMessageMatch) {
    return normalizeText(directMessageMatch[1]);
  }

  const replyMatch = cleaned.match(/(?:^|\s)\/(?:r|reply)\s+([\s\S]+)$/i);
  if (replyMatch) {
    return normalizeText(replyMatch[1]);
  }

  const meMatch = cleaned.match(/(?:^|\s)\/me\s+([\s\S]+)$/i);
  if (meMatch) {
    return normalizeText(meMatch[1]);
  }

  return null;
}

function extractTranslatableTextsFromParts(parts) {
  const seen = new Set();
  const results = [];

  for (const part of parts) {
    const raw = normalizeText(part);
    if (!raw) {
      continue;
    }

    const candidates = [...extractMarkedCode(raw), raw];
    for (const candidate of candidates) {
      for (const line of candidate.split("\n")) {
        const text = extractTextFromCommand(line);
        if (!text || seen.has(text.toLowerCase())) {
          continue;
        }

        seen.add(text.toLowerCase());
        results.push(text);
      }
    }
  }

  return results;
}

function extractTranslatableTexts(message) {
  return extractTranslatableTextsFromParts(collectMessageTextParts(message));
}

module.exports = {
  collectMessageTextParts,
  extractTextFromCommand,
  extractTranslatableTexts,
  extractTranslatableTextsFromParts
};
