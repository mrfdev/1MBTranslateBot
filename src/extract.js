function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function inspectPart(budget, value) {
  budget?.inspect?.(value);
}

function collectEmbedText(embed, budget) {
  const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
  const parts = [];

  if (data.description) {
    inspectPart(budget, data.description);
    parts.push(data.description);
  }

  if (Array.isArray(data.fields)) {
    for (const field of data.fields) {
      if (field.value) {
        inspectPart(budget, field.value);
        parts.push(field.value);
      }
    }
  }

  return parts;
}

function collectEmbedMetadataText(embed, budget) {
  const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
  const parts = [...collectEmbedText(data, budget)];

  if (data.author?.name) {
    inspectPart(budget, data.author.name);
    parts.push(data.author.name);
  }
  if (data.title) {
    inspectPart(budget, data.title);
    parts.push(data.title);
  }
  if (Array.isArray(data.fields)) {
    for (const field of data.fields) {
      if (field.name) {
        inspectPart(budget, field.name);
        parts.push(field.name);
      }
    }
  }
  if (data.footer?.text) {
    inspectPart(budget, data.footer.text);
    parts.push(data.footer.text);
  }

  return parts;
}

function collectMessageTextParts(message, budget) {
  const parts = [];

  if (message.content) {
    inspectPart(budget, message.content);
    parts.push(message.content);
  }

  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      parts.push(...collectEmbedText(embed, budget));
    }
  }

  return parts;
}

function collectMessageSourceGroups(message) {
  const groups = [];

  if (message.content) {
    groups.push([message.content]);
  }

  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
      const parts = [];

      if (data.title) {
        parts.push(data.title);
      }
      if (data.description) {
        parts.push(data.description);
      }
      if (Array.isArray(data.fields)) {
        for (const field of data.fields) {
          if (field.name) {
            parts.push(field.name);
          }
          if (field.value) {
            parts.push(field.value);
          }
        }
      }

      if (parts.length > 0) {
        groups.push(parts);
      }
    }
  }

  return groups;
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

function stripFencedContent(raw) {
  return String(raw || "").split("```", 1)[0];
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
    .replace(/^[`*~'\"]+/, "")
    .replace(/[`*~'\",.:;!?]+$/, "")
    .trim();

  return cleaned || null;
}

function cleanPlayerActor(value) {
  const cleaned = String(value || "")
    .replace(/^[`*~'\"]+/, "")
    .replace(/[`*~'\",.:;!?]+$/, "")
    .trim();

  return /^[A-Za-z0-9_]{1,16}$/u.test(cleaned) ? cleaned : null;
}

function maskFencedCode(raw) {
  const value = String(raw || "");
  let masked = "";
  let inFence = false;

  for (let index = 0; index < value.length; ) {
    if (value.startsWith("```", index)) {
      const lineStart = value.lastIndexOf("\n", index - 1) + 1;
      const nextLine = value.indexOf("\n", index + 3);
      const lineEnd = nextLine < 0 ? value.length : nextLine;
      const beforeFence = value.slice(lineStart, index);
      const afterFence = value.slice(index + 3, lineEnd);
      const orphanClosingFence =
        !inFence && beforeFence.trim().length > 0 && afterFence.trim().length === 0;

      masked += "   ";
      if (!orphanClosingFence) {
        inFence = !inFence;
      }
      index += 3;
      continue;
    }

    const character = value[index];
    masked += inFence && character !== "\r" && character !== "\n" ? " " : character;
    index += 1;
  }

  return masked;
}

function extractMessageActorFromRaw(raw) {
  const marked = raw.match(/^(?:>+\s*)?(?:\*\*)?Message by\s+`([^`\r\n]+)`/im);
  if (marked) {
    return cleanParticipant(marked[1]);
  }

  const plain = removeDiscordMarkdown(raw).match(/^Message by\s+([^\s,\r\n]+)/im);
  return plain ? cleanParticipant(plain[1]) : null;
}

function extractMessageActorsFromRaw(raw) {
  const metadata = maskFencedCode(raw);
  const actors = [];

  for (const line of metadata.split(/\r?\n/gu)) {
    const actor = extractMessageActorFromRaw(line);
    if (actor) {
      actors.push(actor);
    }
  }

  return actors;
}

function extractMessageActor(parts, budget) {
  for (const part of parts) {
    const raw = String(part || "");
    inspectPart(budget, raw);
    const actor = extractMessageActorsFromRaw(raw)[0];
    if (actor) {
      return actor;
    }
  }

  return null;
}

function extractUniqueMessageActor(parts, budget) {
  const actors = new Map();

  for (const part of parts) {
    const raw = String(part || "");
    inspectPart(budget, raw);
    for (const actor of extractMessageActorsFromRaw(raw)) {
      const key = String(actor).toLowerCase();
      if (!actors.has(key)) {
        actors.set(key, actor);
      }
    }
  }

  return actors.size === 1 ? actors.values().next().value : null;
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

function extractSignTextsFromParts(parts, budget) {
  return extractSignEntriesFromParts(parts, budget).map((entry) => entry.text);
}

function extractBookTextsFromParts(parts, budget) {
  return extractBookEntriesFromParts(parts, budget).map((entry) => entry.text);
}

function extractMetadataActor(raw, kind) {
  const metadata = removeDiscordMarkdown(stripFencedContent(raw));
  const pattern =
    kind === "sign"
      ? /^Placed by\s*:?\s*(?:`([^`\r\n]+)`|([A-Za-z0-9_]{1,16}))(?=\s*(?::|,|$))/im
      : /^(?:`([^`\r\n]+)`|([A-Za-z0-9_]{1,16}))\s+edited a book(?=\s|$)/im;
  const match = metadata.match(pattern);

  return match ? cleanPlayerActor(match[1] || match[2]) : null;
}

function extractFencedEntriesFromSourceGroups(sourceGroups, budget, kind) {
  const seen = new Set();
  const results = [];

  for (const parts of sourceGroups) {
    const rawParts = parts.map((part) => String(part || ""));
    const partActors = rawParts.map((raw) => extractMetadataActor(raw, kind));
    const actors = new Map();
    for (const actor of partActors.filter(Boolean)) {
      const key = String(actor).toLowerCase();
      if (!actors.has(key)) {
        actors.set(key, actor);
      }
    }
    const fallbackActor = actors.size === 1 ? actors.values().next().value : null;

    for (const [partIndex, raw] of rawParts.entries()) {
      inspectPart(budget, raw);
      if (!raw.trim()) {
        continue;
      }

      const fencedBlocks = extractFencedCode(raw);
      for (const block of fencedBlocks) {
        const text = cleanSignText(block);
        const actor = partActors[partIndex] || fallbackActor;
        const normalizedText = textKey(text);
        const key = `${String(actor || "").toLowerCase()}\u001f${normalizedText}`;
        if (!text || !normalizedText || seen.has(key)) {
          continue;
        }

        budget?.addCandidate?.(text);
        seen.add(key);
        const entry = {
          text,
          kind,
          actor
        };
        if (kind === "book-page") {
          entry.pageIndex = results.length;
        }
        results.push(entry);
      }
    }
  }

  return results;
}

function extractSignEntriesFromParts(parts, budget) {
  return extractFencedEntriesFromSourceGroups([parts], budget, "sign");
}

function extractBookEntriesFromParts(parts, budget) {
  return extractFencedEntriesFromSourceGroups([parts], budget, "book-page");
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
  const budget = options.budget;
  const seen = new Set();
  const results = [];

  for (const part of parts) {
    const partText = String(part || "");
    inspectPart(budget, partText);
    const detectedActors = new Map();
    for (const actor of extractMessageActorsFromRaw(partText)) {
      detectedActors.set(String(actor).toLowerCase(), actor);
    }
    const fallbackActor =
      options.actor || (detectedActors.size === 1 ? detectedActors.values().next().value : null);
    const maskedPart = maskFencedCode(partText);
    const headerOffsets = [
      ...maskedPart.matchAll(/^(?:>+\s*)?(?:(?:\*\*|__)\s*)?Message by\s+/gimu)
    ].map((match) => match.index);
    const recordOffsets = headerOffsets[0] === 0 ? headerOffsets : [0, ...headerOffsets];
    const records = recordOffsets.map((start, index) =>
      partText.slice(start, recordOffsets[index + 1] ?? partText.length)
    );
    for (const record of records) {
      const raw = String(record || "").replace(/\r\n|\r/g, "\n");
      if (!raw.trim()) {
        continue;
      }

      const actor = extractMessageActor([record], budget) || fallbackActor;

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

          budget?.addCandidate?.(entry.text);
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

function extractTranslatableEntries(message, budget) {
  const entries = [];
  if (message.content) {
    entries.push(...extractTranslatableEntriesFromParts([message.content], { budget }));
  }

  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
      const embedActor = extractUniqueMessageActor(
        collectEmbedMetadataText(data, budget),
        budget
      );

      if (data.description) {
        const actor = extractUniqueMessageActor([data.description], budget) || embedActor;
        entries.push(
          ...extractTranslatableEntriesFromParts([data.description], { actor, budget })
        );
      }

      if (Array.isArray(data.fields)) {
        for (const field of data.fields) {
          if (!field.value) {
            continue;
          }

          const actor =
            extractUniqueMessageActor([field.name, field.value], budget) || embedActor;
          entries.push(
            ...extractTranslatableEntriesFromParts([field.value], { actor, budget })
          );
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

function extractSignTexts(message, budget) {
  return extractSignEntries(message, budget).map((entry) => entry.text);
}

function extractBookTexts(message, budget) {
  return extractBookEntries(message, budget).map((entry) => entry.text);
}

function extractSignEntries(message, budget) {
  return extractFencedEntriesFromSourceGroups(
    collectMessageSourceGroups(message),
    budget,
    "sign"
  );
}

function extractBookEntries(message, budget) {
  return extractFencedEntriesFromSourceGroups(
    collectMessageSourceGroups(message),
    budget,
    "book-page"
  );
}

module.exports = {
  collectMessageTextParts,
  extractBookEntries,
  extractBookEntriesFromParts,
  extractBookTexts,
  extractBookTextsFromParts,
  extractMessageActor,
  extractTranslatableEntries,
  extractTranslatableEntriesFromParts,
  extractTextFromCommand,
  extractSignEntries,
  extractSignEntriesFromParts,
  extractSignTexts,
  extractSignTextsFromParts,
  extractTranslatableTexts,
  extractTranslatableTextsFromParts,
  parseCommand
};
