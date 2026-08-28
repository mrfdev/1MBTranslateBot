function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
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

function collectEmbedMetadataText(embed) {
  const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
  const parts = [...collectEmbedText(data)];

  if (data.author?.name) {
    parts.push(data.author.name);
  }
  if (data.title) {
    parts.push(data.title);
  }
  if (Array.isArray(data.fields)) {
    for (const field of data.fields) {
      if (field.name) {
        parts.push(field.name);
      }
    }
  }
  if (data.footer?.text) {
    parts.push(data.footer.text);
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
  const samples = extractFencedCode(raw);

  const fencedPattern = /```([\s\S]*?)```/g;
  const withoutFencedBlocks = raw.replace(fencedPattern, "\n");
  const inlinePattern = /`([^`\n]+)`/g;
  for (const match of withoutFencedBlocks.matchAll(inlinePattern)) {
    samples.push(match[1]);
  }

  return samples;
}

function extractFencedCode(raw) {
  const samples = [];
  const fencedPattern = /```([\s\S]*?)```/g;

  for (const match of raw.matchAll(fencedPattern)) {
    samples.push(match[1]);
  }

  return samples;
}

function stripMarkedCode(raw) {
  return raw
    .replace(/```[\s\S]*?```/g, "\n")
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

function parseCommand(line) {
  const raw = String(line || "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/^>+\s?/gm, "");
  const commandStart = raw.search(
    /\/(?:cmi\s+)?(?:msg|message|tell|w|whisper|m|pm)\b|\/(?:r|reply|me)\b/i
  );
  if (commandStart < 0) {
    return null;
  }
  const cleaned = raw.slice(commandStart).replace(/```+\s*$/u, "");

  const directMessageMatch = cleaned.match(
    /^\/(?:cmi\s+)?(msg|message|tell|w|whisper|m|pm)\s+(\S+)\s+([\s\S]+)$/i
  );
  if (directMessageMatch) {
    const text = cleanExtractedText(directMessageMatch[3]);
    return text
      ? {
          text,
          kind: "direct-message",
          command: directMessageMatch[1].toLowerCase(),
          recipient: cleanParticipant(directMessageMatch[2])
        }
      : null;
  }

  const replyMatch = cleaned.match(/^\/(?:r|reply)\s+([\s\S]+)$/i);
  if (replyMatch) {
    const text = cleanExtractedText(replyMatch[1]);
    return text
      ? {
          text,
          kind: "reply",
          command: "reply",
          recipient: null
        }
      : null;
  }

  const meMatch = cleaned.match(/^\/me\s+([\s\S]+)$/i);
  if (meMatch) {
    const text = cleanExtractedText(meMatch[1]);
    return text
      ? {
          text,
          kind: "action",
          command: "me",
          recipient: null
        }
      : null;
  }

  return null;
}

function extractTextFromCommand(line) {
  return parseCommand(line)?.text || null;
}

function cleanParticipant(value) {
  const cleaned = String(value || "")
    .replace(/^[`*_~'\"]+/, "")
    .replace(/[`*_~'\",.:;!?]+$/, "")
    .trim();

  return cleaned || null;
}

function extractMessageActor(parts) {
  for (const part of parts) {
    const raw = String(part || "");
    const marked = raw.match(/^(?:>+\s*)?(?:\*\*)?Message by\s+`([^`\r\n]+)`/im);
    if (marked) {
      return cleanParticipant(marked[1]);
    }

    const plain = removeDiscordMarkdown(raw).match(/^Message by\s+([^\s,\r\n]+)/im);
    if (plain) {
      return cleanParticipant(plain[1]);
    }
  }

  return null;
}

function cleanExtractedText(value) {
  const cleaned = String(value || "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/^```(?:text)?\s*/iu, "")
    .replace(/```+\s*$/u, "");

  return cleaned.trim() ? cleaned : null;
}

function cleanSignText(value) {
  let cleaned = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (cleaned.startsWith("\n")) {
    cleaned = cleaned.slice(1);
  }
  if (cleaned.endsWith("\n")) {
    cleaned = cleaned.slice(0, -1);
  }

  return cleaned.trim() ? cleaned : null;
}

function textKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/^[`'"]+/, "")
    .replace(/[`'"]+$/, "")
    .replace(/\s+/g, " ");
}

function extractSignTextsFromParts(parts) {
  return extractFencedTextsFromParts(parts);
}

function extractBookTextsFromParts(parts) {
  return extractFencedTextsFromParts(parts);
}

function extractFencedTextsFromParts(parts) {
  const seen = new Set();
  const results = [];

  for (const part of parts) {
    const raw = String(part || "");
    if (!raw.trim()) {
      continue;
    }

    const fencedBlocks = extractFencedCode(raw);
    for (const block of fencedBlocks) {
      const text = cleanSignText(block);
      const key = textKey(text);
      if (!text || !key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      results.push(text);
    }
  }

  return results;
}

function extractTranslatableTextsFromParts(parts) {
  return extractTranslatableEntriesFromParts(parts).map((entry) => entry.text);
}

function entryKey(entry) {
  return [
    entry.actor || "",
    entry.kind,
    entry.recipient || "",
    textKey(entry.text)
  ].join("\u001f");
}

function extractTranslatableEntriesFromParts(parts, options = {}) {
  const seen = new Set();
  const results = [];
  const detectedActors = [
    ...new Set(parts.flatMap((part) => extractMessageActor([part]) || []).filter(Boolean))
  ];
  const fallbackActor = options.actor || (detectedActors.length === 1 ? detectedActors[0] : null);

  for (const part of parts) {
    const records = String(part || "").split(/(?=^(?:>+\s*)?(?:\*\*)?Message by\s+)/gim);
    for (const record of records) {
      const raw = String(record || "").replace(/\r\n|\r/g, "\n");
      if (!raw.trim()) {
        continue;
      }

      const actor = extractMessageActor([record]) || fallbackActor;

      const candidates = [...extractMarkedCode(raw), stripMarkedCode(raw)];
      for (const candidate of candidates) {
        for (const line of candidate.split("\n")) {
          const parsed = parseCommand(line);
          if (!parsed) {
            continue;
          }

          const entry = {
            ...parsed,
            actor
          };
          const key = entryKey(entry);
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          results.push(entry);
        }
      }
    }
  }

  return results;
}

function extractTranslatableTexts(message) {
  return extractTranslatableEntries(message).map((entry) => entry.text);
}

function extractTranslatableEntries(message) {
  const entries = [];
  if (message.content) {
    entries.push(...extractTranslatableEntriesFromParts([message.content]));
  }

  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
      const embedActor = extractMessageActor(collectEmbedMetadataText(data));

      if (data.description) {
        const actor = extractMessageActor([data.description]) || embedActor;
        entries.push(...extractTranslatableEntriesFromParts([data.description], { actor }));
      }

      if (Array.isArray(data.fields)) {
        for (const field of data.fields) {
          if (!field.value) {
            continue;
          }

          const actor = extractMessageActor([field.name, field.value]) || embedActor;
          entries.push(...extractTranslatableEntriesFromParts([field.value], { actor }));
        }
      }
    }
  }

  const seen = new Set();
  return entries.filter((entry) => {
    const key = entryKey(entry);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function extractSignTexts(message) {
  return extractSignTextsFromParts(collectMessageTextParts(message));
}

function extractBookTexts(message) {
  return extractBookTextsFromParts(collectMessageTextParts(message));
}

module.exports = {
  collectMessageTextParts,
  extractBookTexts,
  extractBookTextsFromParts,
  extractMessageActor,
  extractTranslatableEntries,
  extractTranslatableEntriesFromParts,
  extractTextFromCommand,
  extractSignTexts,
  extractSignTextsFromParts,
  extractTranslatableTexts,
  extractTranslatableTextsFromParts,
  parseCommand
};
