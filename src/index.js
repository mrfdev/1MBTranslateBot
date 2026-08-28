const { Client, Events, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const path = require("node:path");
const packageJson = require("../package.json");
const { loadConfig } = require("./config");
const { ConversationContextStore } = require("./context");
const {
  canUseHealthCommand,
  ensureHealthCommand,
  ephemeralReply,
  formatDiscordHealth,
  isHealthCommandInteraction
} = require("./discord-health");
const { extractBookTexts, extractSignTexts, extractTranslatableEntries } = require("./extract");
const { formatTranslation: formatTranslationResult } = require("./format");
const { buildHealthSnapshot, writeHealthSnapshot } = require("./health");
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
const serviceStartedAt = new Date();
const serviceProjectRoot = path.resolve(
  process.env.TRANSLATIONBOT_PROJECT_ROOT || path.resolve(__dirname, "..")
);
const healthState = {
  lifecycle: "starting",
  discord: {
    gateway: "connecting",
    server: "unknown",
    command: "registering",
    channels: {
      message_log: "unknown",
      sign_log: config.signChannelId ? "unknown" : "not-configured",
      book_log: config.bookChannelId ? "unknown" : "not-configured"
    },
    gateway_errors: 0
  },
  backend: {
    ollama_service_available: null,
    ollama_model_available: null,
    legacy_available: null,
    checked_at: null
  }
};
let healthWriteFailures = 0;

function createHealthSnapshot() {
  const translationMetrics = translationService.metricsSnapshot();
  return buildHealthSnapshot({
    version: packageJson.version,
    release: process.env.TRANSLATIONBOT_RELEASE,
    startedAt: serviceStartedAt,
    heartbeatIntervalMs: config.healthSnapshotIntervalMs,
    lifecycle: healthState.lifecycle,
    discord: healthState.discord,
    translationMode: config.translationMode,
    backend: healthState.backend,
    translationMetrics,
    legacyMetrics: legacy?.metricsSnapshot?.() || null,
    messageQueue: messageQueue.snapshot(),
    context: conversationContext.snapshot(),
    cacheMaxEntries: config.translationCacheMaxEntries,
    cacheTtlMs: config.translationCacheTtlMs
  });
}

function publishHealthSnapshot() {
  try {
    const snapshot = createHealthSnapshot();
    writeHealthSnapshot(serviceProjectRoot, snapshot);
    healthWriteFailures = 0;
    return snapshot;
  } catch {
    healthWriteFailures += 1;
    if (healthWriteFailures === 1) {
      console.error("[translate-bot] Health snapshot write failed.");
    }
    return null;
  }
}

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
    return "not-configured";
  }
  let channel;
  try {
    channel = await readyClient.channels.fetch(channelId);
  } catch {
    console.error(`[translate-bot] ${label}: unavailable`);
    return "unavailable";
  }

  let permissions;
  try {
    permissions = channel.permissionsFor(readyClient.user.id);
  } catch {
    console.error(`[translate-bot] ${label}: unavailable`);
    return "unavailable";
  }
  const checks = [
    ["view", PermissionsBitField.Flags.ViewChannel],
    ["send", PermissionsBitField.Flags.SendMessages],
    ["history", PermissionsBitField.Flags.ReadMessageHistory]
  ];
  const summary = checks
    .map(([name, permission]) => `${name}=${permissions?.has(permission) ? "yes" : "no"}`)
    .join(", ");
  console.log(`[translate-bot] ${label}: available (${summary})`);
  return checks.every(([, permission]) => permissions?.has(permission))
    ? "available"
    : "insufficient-permissions";
}

async function logRuntimeAccess(readyClient) {
  console.log("[translate-bot] Discord login: ready");
  healthState.discord.gateway = "ready";
  let guild;
  try {
    guild =
      readyClient.guilds.cache.get(config.guildId) ||
      (await readyClient.guilds.fetch(config.guildId));
  } catch {
    console.error("[translate-bot] Configured Discord server: unavailable");
    healthState.discord.server = "unavailable";
    healthState.discord.command = "unavailable";
    healthState.discord.channels.message_log = "unavailable";
    healthState.discord.channels.sign_log = config.signChannelId
      ? "unavailable"
      : "not-configured";
    healthState.discord.channels.book_log = config.bookChannelId
      ? "unavailable"
      : "not-configured";
    publishHealthSnapshot();
    return null;
  }
  console.log("[translate-bot] Configured Discord server: available");
  healthState.discord.server = "available";
  healthState.discord.channels.message_log = await logChannelAccess(
    readyClient,
    "message log channel",
    config.logChannelId
  );
  healthState.discord.channels.sign_log = await logChannelAccess(
    readyClient,
    "sign log channel",
    config.signChannelId
  );
  healthState.discord.channels.book_log = await logChannelAccess(
    readyClient,
    "book log channel",
    config.bookChannelId
  );
  publishHealthSnapshot();
  return guild;
}

async function registerRuntimeHealthCommand(guild) {
  try {
    const registration = await ensureHealthCommand(guild);
    healthState.discord.command = "available";
    console.log(`[translate-bot] Discord health command: ${registration}`);
  } catch {
    healthState.discord.command = "unavailable";
    console.error("[translate-bot] Discord health command: unavailable");
  }
  publishHealthSnapshot();
}

async function handleHealthInteraction(interaction) {
  if (!canUseHealthCommand(interaction, config.guildId)) {
    await interaction.reply(
      ephemeralReply("Manage Server permission is required to view TranslationBot health.")
    );
    return;
  }
  const subcommand = interaction.options.getSubcommand(true);
  const snapshot = createHealthSnapshot();
  await interaction.reply(
    ephemeralReply(
      formatDiscordHealth(snapshot, { alertTest: subcommand === "alert-test" })
    )
  );
}

let backendRefreshPromise = null;

function refreshTranslationBackend({ announce = false } = {}) {
  if (backendRefreshPromise) {
    return backendRefreshPromise;
  }
  backendRefreshPromise = (async () => {
    const [ollamaHealth, legacyHealth] = await Promise.all([
      ollama ? ollama.healthCheck() : null,
      legacy ? legacy.healthCheck() : null
    ]);
    healthState.backend = {
      ollama_service_available: ollamaHealth?.serviceAvailable ?? null,
      ollama_model_available: ollamaHealth?.modelAvailable ?? null,
      legacy_available: legacyHealth?.ok ?? null,
      checked_at: new Date().toISOString()
    };
    if (announce && ollamaHealth) {
      console.log(
        `[translate-bot] Ollama service: ${ollamaHealth.serviceAvailable ? "available" : "unavailable"}`
      );
      console.log(
        `[translate-bot] Configured Ollama model: ${ollamaHealth.modelAvailable ? "available" : "unavailable"}`
      );
    }
    if (announce && legacyHealth) {
      console.log(
        `[translate-bot] Legacy local translator: ${legacyHealth.ok ? "available" : "unavailable"}`
      );
    }
    publishHealthSnapshot();
  })().finally(() => {
    backendRefreshPromise = null;
  });
  return backendRefreshPromise;
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
  healthState.lifecycle = "running";
  logTranslationConfig();
  console.log(
    `[translate-bot] Risk flagging: ${config.enableRiskFlag ? "enabled" : "disabled"}`
  );
  if (config.sourceBotIds.size === 0) {
    console.log("[translate-bot] SOURCE_BOT_IDS is empty; all eligible bots/webhooks are watched.");
  }
  void (async () => {
    const guild = await logRuntimeAccess(readyClient);
    await Promise.all([
      guild ? registerRuntimeHealthCommand(guild) : null,
      refreshTranslationBackend({ announce: true })
    ]);
  })();
});

client.on(Events.ShardDisconnect, () => {
  healthState.discord.gateway = "disconnected";
  publishHealthSnapshot();
});

client.on(Events.ShardReconnecting, () => {
  healthState.discord.gateway = "connecting";
  publishHealthSnapshot();
});

client.on(Events.ShardReady, () => {
  healthState.discord.gateway = "ready";
  publishHealthSnapshot();
});

client.on(Events.Error, () => {
  healthState.discord.gateway_errors += 1;
  publishHealthSnapshot();
});

client.on(Events.MessageCreate, (message) => {
  void messageQueue.run(() => handleMessage(message)).catch((error) => {
    console.error(
      `[translate-bot] Message work was rejected (${safeErrorCode(error)}); content was left unchanged.`
    );
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!isHealthCommandInteraction(interaction)) {
    return;
  }
  void handleHealthInteraction(interaction).catch(async () => {
    console.error("[translate-bot] Discord health command response failed.");
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(ephemeralReply("TranslationBot health could not be read right now."))
        .catch(() => {});
    }
  });
});

let metricsTimer = null;
if (config.metricsIntervalMs > 0) {
  metricsTimer = setInterval(logPrivacyMetrics, config.metricsIntervalMs);
  metricsTimer.unref?.();
}

const healthTimer = setInterval(() => {
  void refreshTranslationBackend();
}, config.healthSnapshotIntervalMs);
healthTimer.unref?.();
publishHealthSnapshot();

function shutdown() {
  if (metricsTimer) {
    clearInterval(metricsTimer);
  }
  clearInterval(healthTimer);
  healthState.lifecycle = "stopping";
  publishHealthSnapshot();
  logPrivacyMetrics();
  console.log("[translate-bot] Shutting down.");
  client.destroy();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

void client.login(config.discordToken).catch(() => {
  healthState.lifecycle = "failed";
  healthState.discord.gateway = "unavailable";
  publishHealthSnapshot();
  console.error("[translate-bot] Discord login failed.");
  process.exitCode = 1;
});
