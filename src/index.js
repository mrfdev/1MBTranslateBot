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
const {
  extractBookEntries,
  extractSignEntries,
  extractTranslatableEntries
} = require("./extract");
const { formatTranslation: formatTranslationResult } = require("./format");
const { buildHealthSnapshot, writeHealthSnapshot } = require("./health");
const {
  MessageWorkBudget,
  isMessageWorkLimitError,
  shouldHandleMessage: messagePassesPolicy
} = require("./message-policy");
const { BoundedExecutor, OllamaTranslateClient } = require("./ollama-translator");
const {
  entryForConversationContext,
  processEntryWithPlayerPolicy
} = require("./player-policy");
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
        repairMinimumConfidence: config.ollamaMinConfidence,
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
        maxResponseBytes: config.libreTranslateMaxResponseBytes,
        maxOutputChars: config.maxTranslationLength,
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

function watchedChannelIds() {
  return new Set(
    [config.logChannelId, config.signChannelId, config.bookChannelId].filter(Boolean)
  );
}

function shouldHandleMessage(message) {
  return messagePassesPolicy(message, {
    guildId: config.guildId,
    watchedChannelIds: watchedChannelIds(),
    clientUserId: client.user?.id,
    sourceBotIds: config.sourceBotIds,
    sourceWebhookIds: config.sourceWebhookIds,
    allowAnySource: config.allowAnySource,
    translateHumanMessages: config.translateHumanMessages
  });
}

function extractEntriesForMessage(message, budget) {
  if (config.signChannelId && message.channelId === config.signChannelId) {
    return extractSignEntries(message, budget);
  }
  if (config.bookChannelId && message.channelId === config.bookChannelId) {
    return extractBookEntries(message, budget);
  }
  return extractTranslatableEntries(message, budget);
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

async function sendOutputChunks(message, chunks, budget) {
  const [first, ...rest] = chunks;
  try {
    budget.addSendAttempt();
    await budget.waitFor(
      message.reply({
        content: first,
        allowedMentions: { parse: [], repliedUser: false }
      })
    );
  } catch (error) {
    if (isMessageWorkLimitError(error)) {
      throw error;
    }
    budget.addSendAttempt();
    await budget.waitFor(
      message.channel.send({ content: first, allowedMentions: { parse: [] } })
    );
  }
  for (const chunk of rest) {
    budget.addSendAttempt();
    await budget.waitFor(
      message.channel.send({
        content: chunk,
        allowedMentions: { parse: [] }
      })
    );
  }
}

async function handleMessage(message) {
  if (!shouldHandleMessage(message)) {
    return;
  }
  const budget = new MessageWorkBudget({
    maxInspectedChars: config.messageMaxInspectedChars,
    maxCandidates: config.messageMaxCandidates,
    maxCandidateChars: config.messageMaxCandidateChars,
    processingBudgetMs: config.messageProcessingBudgetMs,
    maxOutputChars: config.messageMaxOutputChars,
    maxOutputChunks: config.messageMaxOutputChunks
  });

  try {
    const entries = extractEntriesForMessage(message, budget);
    if (entries.length === 0) {
      return;
    }

    const outputs = [];
    const documentContext = [];
    const conversationTurns = conversationContext.beginTurns(
      entries.map((entry) =>
        entryForConversationContext(entry, config.ignoredPlayerNames)
      )
    );
    for (const [entryIndex, entry] of entries.entries()) {
      budget.assertActive();
      const conversationTurn = conversationTurns[entryIndex];
      const priorContext =
        entry.kind === "book-page"
          ? documentContext.slice(-config.contextMessageLimit)
          : conversationContext.contextForTurn(conversationTurn);
      let result = null;
      try {
        result = await budget.waitFor(
          processEntryWithPlayerPolicy({
            entry,
            context: priorContext,
            ignoredPlayerNames: config.ignoredPlayerNames,
            translationService,
            translationOptions: {
              signal: budget.signal,
              trackBackgroundTask: (task) => budget.trackBackground(task)
            }
          })
        );
        budget.assertActive();
        if (result) {
          const pageLabel = entry.kind === "book-page" ? `Page ${entry.pageIndex + 1}\n` : "";
          const output = `${pageLabel}${formatTranslation(result)}`;
          budget.addOutput(output);
          outputs.push(output);
        }
      } catch (error) {
        if (isMessageWorkLimitError(error) || budget.signal.aborted) {
          result = null;
          throw error;
        }
        console.error(
          `[translate-bot] Translation processing failed (${safeErrorCode(error)}); original text was left unchanged.`
        );
      } finally {
        if (conversationTurn) {
          conversationContext.remember(conversationTurn, entry, result);
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
    budget.setOutputChunks(chunks.length);
    await sendOutputChunks(message, chunks, budget);
  } catch (error) {
    if (isMessageWorkLimitError(error) || budget.signal.aborted) {
      console.error(
        `[translate-bot] Message work stopped (${error?.code || "message-time-budget"}); remaining content was left unchanged.`
      );
      return;
    }
    console.error(
      `[translate-bot] Message processing failed (${safeErrorCode(error)}); content was left unchanged.`
    );
  } finally {
    budget.finish();
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
  console.log(
    `[translate-bot] Ignored Minecraft players: ${config.ignoredPlayerNames.size}`
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
  if (config.allowAnySource) {
    console.log("[translate-bot] ALLOW_ANY_SOURCE is enabled; all eligible bots/webhooks are watched.");
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

client.on(Events.ShardResume, () => {
  healthState.discord.gateway = "ready";
  publishHealthSnapshot();
});

client.on(Events.Error, () => {
  healthState.discord.gateway_errors += 1;
  publishHealthSnapshot();
});

client.on(Events.MessageCreate, (message) => {
  if (!shouldHandleMessage(message)) {
    return;
  }
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
