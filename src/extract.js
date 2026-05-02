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

  for (const match of raw.matchAll(fencedPattern)) {
    samples.push(match[1]);
  }

  const withoutFencedBlocks = raw.replace(fencedPattern, "\n");
  const inlinePattern = /`([^`\n]+)`/g;
  for (const match of withoutFencedBlocks.matchAll(inlinePattern)) {
    samples.push(match[1]);
  }

  return samples;
}

function stripMarkedCode(raw) {
  return raw
    .replace(/```(?:\w+)?\n?[\s\S]*?```/g, "\n")
    .replace(/`[^`\n]+`/g, " ");
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
    return cleanExtractedText(directMessageMatch[1]);
  }

  const replyMatch = cleaned.match(/(?:^|\s)\/(?:r|reply)\s+([\s\S]+)$/i);
  if (replyMatch) {
    return cleanExtractedText(replyMatch[1]);
  }

  const meMatch = cleaned.match(/(?:^|\s)\/me\s+([\s\S]+)$/i);
  if (meMatch) {
    return cleanExtractedText(meMatch[1]);
  }

  return null;
}

function cleanExtractedText(value) {
  const cleaned = normalizeText(value)
    .replace(/^[`'"]+/, "")
    .replace(/[`'"]+$/, "")
    .trim();

  return cleaned || null;
}

function textKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/^[`'"]+/, "")
    .replace(/[`'"]+$/, "")
    .replace(/\s+/g, " ");
}

function extractTranslatableTextsFromParts(parts) {
  const seen = new Set();
  const results = [];

  for (const part of parts) {
    const raw = normalizeText(part);
    if (!raw) {
      continue;
    }

    const candidates = [...extractMarkedCode(raw), stripMarkedCode(raw)];
    for (const candidate of candidates) {
      for (const line of candidate.split("\n")) {
        const text = extractTextFromCommand(line);
        const key = textKey(text);
        if (!text || !key || seen.has(key)) {
          continue;
        }

        seen.add(key);
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
