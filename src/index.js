const { Client, Events, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const { loadConfig } = require("./config");
const { ConversationContextStore } = require("./context");
const { extractBookTexts, extractSignTexts, extractTranslatableEntries } = require("./extract");
const { formatTranslation: formatTranslationResult } = require("./format");
const { BoundedExecutor, OllamaTranslateClient } = require("./ollama-translator");
const { TranslationService, safeErrorCode } = require("./translation-service");
const { LibreTranslateClient } = require("./translator");

const config = loadConfig();
const ollama =
  config.translationMode === "off"
    ? null
    : new OllamaTranslateClient({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        targetLanguage: config.targetLanguage,
        timeoutMs: config.ollamaTimeoutMs,
        statusTimeoutMs: config.ollamaStatusTimeoutMs,
        keepAlive: config.ollamaKeepAlive,
        maxInputChars: config.ollamaMaxInputChars,
        maxOutputChars: config.maxTranslationLength,
        maxOutputTokens: config.ollamaMaxOutputTokens,
        maxResponseBytes: config.ollamaMaxResponseBytes,
        maxConcurrency: config.ollamaMaxConcurrency,
        queueLimit: config.ollamaQueueLimit,
        circuitFailureThreshold: config.ollamaCircuitFailureThreshold,
        circuitCooldownMs: config.ollamaCircuitCooldownMs,
        cacheMaxEntries: config.translationCacheMaxEntries,
        cacheTtlMs: config.translationCacheTtlMs,
        contextMessageLimit: config.contextMessageLimit,
        contextMaxChars: config.contextMaxChars
      });
const legacy =
  config.translationMode === "active"
    ? null
    : new LibreTranslateClient({
        baseUrl: config.libreTranslateUrl,
        apiKey: config.libreTranslateApiKey,
        targetLanguage: config.targetLanguage,
        alternatives: config.translationAlternatives,
        timeoutMs: config.translationTimeoutMs,
        delayMs: config.translationDelayMs,
        cacheMaxEntries: config.translationCacheMaxEntries,
        cacheTtlMs: config.translationCacheTtlMs
      });
const translationService = new TranslationService({
  mode: config.translationMode,
  ollama,
  legacy,
  targetLanguage: config.targetLanguage,
  minimumConfidence: config.ollamaMinConfidence,
  minimumDetectionConfidence: config.minDetectionConfidence,
  contextLanguageConfidence: config.contextLanguageConfidence,
  maxInputChars: config.ollamaMaxInputChars,
  maxTranslations: config.maxTranslationsPerMessage,
  enableRiskFlag: config.enableRiskFlag,
  extraFlaggedTerms: config.extraFlaggedTerms
});
const conversationContext = new ConversationContextStore({
  maxConversations: config.contextMaxConversations,
  maxMessages: config.contextMessageLimit,
  ttlMs: config.contextTtlMs
});
const messageQueue = new BoundedExecutor({
  maxConcurrency: config.messageMaxConcurrency,
  queueLimit: config.messageQueueLimit
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const seenSourceIds = new Set();

function watchedChannelIds() {
  return new Set(
    [config.logChannelId, config.signChannelId, config.bookChannelId].filter(Boolean)
  );
}

function shouldHandleMessage(message) {
  if (!message.guildId || message.guildId !== config.guildId) {
    return false;
  }
  if (!watchedChannelIds().has(message.channelId)) {
    return false;
  }
  if (message.author?.id === client.user?.id) {
    return false;
  }
  if (config.sourceBotIds.size > 0) {
    return config.sourceBotIds.has(message.author?.id);
  }
  return Boolean(message.author?.bot || message.webhookId || config.translateHumanMessages);
}

function extractEntriesForMessage(message) {
  if (config.signChannelId && message.channelId === config.signChannelId) {
    return extractSignTexts(message).map((text) => ({
      text,
      kind: "sign",
      actor: null,
      recipient: null
    }));
  }
  if (config.bookChannelId && message.channelId === config.bookChannelId) {
    return extractBookTexts(message).map((text, pageIndex) => ({
      text,
      kind: "book-page",
      pageIndex,
      actor: null,
      recipient: null
    }));
  }
  return extractTranslatableEntries(message);
}

function formatTranslation(result) {
  return formatTranslationResult(result, {
    maxOriginalLength: config.maxOriginalLength,
    maxTranslationLength: config.maxTranslationLength,
    maxTranslationsPerMessage: config.maxTranslationsPerMessage
  });
}

function chunkOutputs(outputs, maxLength = 1_900) {
  const chunks = [];
  let current = "";
  for (const output of outputs) {
    const next = current ? `${current}\n\n${output}` : output;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    if (output.length <= maxLength) {
      current = output;
      continue;
    }
    chunks.push(`${output.slice(0, maxLength - 1)}…`);
    current = "";
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function sendOutputChunks(message, chunks) {
  const [first, ...rest] = chunks;
  await message.reply({
    content: first,
    allowedMentions: { parse: [], repliedUser: false }
  });
  for (const chunk of rest) {
    await message.channel.send({
      content: chunk,
      allowedMentions: { parse: [] }
    });
  }
}

async function handleMessage(message) {
  if (!shouldHandleMessage(message)) {
    return;
  }
  if (
    config.sourceBotIds.size === 0 &&
    message.author?.id &&
    !seenSourceIds.has(message.author.id)
  ) {
    seenSourceIds.add(message.author.id);
    console.log(
      "[translate-bot] A source bot or webhook was observed. Configure SOURCE_BOT_IDS to narrow the source."
    );
  }

  const entries = extractEntriesForMessage(message);
  if (entries.length === 0) {
    return;
  }

  const outputs = [];
  const documentContext = [];
  for (const entry of entries) {
    const priorContext =
      entry.kind === "book-page"
        ? documentContext.slice(-config.contextMessageLimit)
        : conversationContext.contextFor(entry);
    let result = null;
    try {
      result = await translationService.translate(entry, priorContext);
      if (result) {
        const pageLabel = entry.kind === "book-page" ? `Page ${entry.pageIndex + 1}\n` : "";
        outputs.push(`${pageLabel}${formatTranslation(result)}`);
      }
    } catch (error) {
      console.error(
        `[translate-bot] Translation processing failed (${safeErrorCode(error)}); original text was left unchanged.`
      );
    } finally {
      if (["direct-message", "reply"].includes(entry.kind)) {
        conversationContext.remember(entry, result);
      }
      if (entry.kind === "book-page" && result?.translations?.[0]) {
        documentContext.push({
          original: entry.text,
          translation: result.translations[0],
          language: result.language,
          confidence: result.confidence
        });
        if (documentContext.length > config.contextMessageLimit) {
          documentContext.splice(0, documentContext.length - config.contextMessageLimit);
        }
      }
    }
  }

  if (outputs.length === 0) {
    return;
  }
  const chunks = chunkOutputs(outputs);
  try {
    await sendOutputChunks(message, chunks);
  } catch {
    console.error("[translate-bot] Reply failed; retrying as a channel message.");
    for (const chunk of chunks) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }
}

async function logChannelAccess(readyClient, label, channelId) {
  if (!channelId) {
    console.log(`[translate-bot] ${label}: not configured`);
    return;
  }
  let channel;
  try {
    channel = await readyClient.channels.fetch(channelId);
  } catch {
    console.error(`[translate-bot] ${label}: unavailable`);
    return;
  }

  const permissions = channel.permissionsFor(readyClient.user.id);
  const checks = [
    ["view", PermissionsBitField.Flags.ViewChannel],
    ["send", PermissionsBitField.Flags.SendMessages],
    ["history", PermissionsBitField.Flags.ReadMessageHistory]
  ];
  const summary = checks
    .map(([name, permission]) => `${name}=${permissions?.has(permission) ? "yes" : "no"}`)
    .join(", ");
  console.log(`[translate-bot] ${label}: available (${summary})`);
}

async function logRuntimeAccess(readyClient) {
  console.log("[translate-bot] Discord login: ready");
  let guild;
  try {
    guild =
      readyClient.guilds.cache.get(config.guildId) ||
      (await readyClient.guilds.fetch(config.guildId));
  } catch {
    console.error("[translate-bot] Configured Discord server: unavailable");
    return;
  }
  console.log("[translate-bot] Configured Discord server: available");
  await logChannelAccess(readyClient, "message log channel", config.logChannelId);
  await logChannelAccess(readyClient, "sign log channel", config.signChannelId);
  await logChannelAccess(readyClient, "book log channel", config.bookChannelId);
  void guild;
}

async function logTranslationBackendAccess() {
  if (ollama) {
    const health = await ollama.healthCheck();
    console.log(
      `[translate-bot] Ollama service: ${health.serviceAvailable ? "available" : "unavailable"}`
    );
    console.log(
      `[translate-bot] Configured Ollama model: ${health.modelAvailable ? "available" : "unavailable"}`
    );
  }
  if (legacy) {
    const health = await legacy.healthCheck();
    console.log(`[translate-bot] Legacy local translator: ${health.ok ? "available" : "unavailable"}`);
  }
}

function logTranslationConfig() {
  console.log(`[translate-bot] Ollama mode: ${config.translationMode}`);
  console.log(`[translate-bot] Active confidence threshold: ${config.ollamaMinConfidence}`);
  console.log(
    `[translate-bot] Ollama capacity: ${config.ollamaMaxConcurrency} active, ${config.ollamaQueueLimit} queued`
  );
  console.log(
    `[translate-bot] In-memory result cache: ${config.translationCacheMaxEntries} entries, ${config.translationCacheTtlMs}ms TTL`
  );
}

function logPrivacyMetrics() {
  const metrics = translationService.metricsSnapshot();
  console.log(`[translate-bot] Privacy-safe translation metrics: ${JSON.stringify(metrics)}`);
}

client.once(Events.ClientReady, (readyClient) => {
  void logRuntimeAccess(readyClient);
  void logTranslationBackendAccess();
  logTranslationConfig();
  console.log(
    `[translate-bot] Risk flagging: ${config.enableRiskFlag ? "enabled" : "disabled"}`
  );
  if (config.sourceBotIds.size === 0) {
    console.log("[translate-bot] SOURCE_BOT_IDS is empty; all eligible bots/webhooks are watched.");
  }
});

client.on(Events.MessageCreate, (message) => {
  void messageQueue.run(() => handleMessage(message)).catch((error) => {
    console.error(
      `[translate-bot] Message work was rejected (${safeErrorCode(error)}); content was left unchanged.`
    );
  });
});

let metricsTimer = null;
if (config.metricsIntervalMs > 0) {
  metricsTimer = setInterval(logPrivacyMetrics, config.metricsIntervalMs);
  metricsTimer.unref?.();
}

function shutdown() {
  if (metricsTimer) {
    clearInterval(metricsTimer);
  }
  logPrivacyMetrics();
  console.log("[translate-bot] Shutting down.");
  client.destroy();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

void client.login(config.discordToken).catch(() => {
  console.error("[translate-bot] Discord login failed.");
  process.exitCode = 1;
});
