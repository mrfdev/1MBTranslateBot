const { Client, Events, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const { loadConfig } = require("./config");
const { extractTranslatableTexts } = require("./extract");
const { looksProbablyEnglish } = require("./language");
const { shouldFlagText } = require("./safety");
const { LibreTranslateClient, languageName } = require("./translator");

const config = loadConfig();
const translator = new LibreTranslateClient({
  baseUrl: config.libreTranslateUrl,
  apiKey: config.libreTranslateApiKey,
  targetLanguage: config.targetLanguage,
  alternatives: config.translationAlternatives,
  timeoutMs: config.translationTimeoutMs,
  delayMs: config.translationDelayMs
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let queue = Promise.resolve();
const seenSourceIds = new Set();

function enqueue(task) {
  queue = queue.then(task).catch((error) => {
    console.error("[translate-bot] Queue task failed:", error);
  });

  return queue;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function escapeBackticks(value) {
  return value.replace(/`/g, "'");
}

function hasMeaningfulTranslation(original, translations) {
  if (!Array.isArray(translations) || translations.length === 0) {
    return false;
  }

  return translations.some((translated) => original.trim().toLowerCase() !== translated.trim().toLowerCase());
}

function shouldHandleMessage(message) {
  if (!message.guildId || message.guildId !== config.guildId) {
    return false;
  }

  if (message.channelId !== config.logChannelId) {
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

async function translateOne(original) {
  if (looksProbablyEnglish(original)) {
    console.log(`[translate-bot] Skipping likely English text: "${truncate(original, 80)}"`);
    return null;
  }

  const detected = await translator.detect(original);
  const detectedLanguage = detected.language;
  const confidence = detected.confidence;

  if (detectedLanguage === config.targetLanguage && confidence >= config.minDetectionConfidence) {
    return null;
  }

  const sourceLanguage = confidence >= config.minDetectionConfidence ? detectedLanguage : "auto";
  const translations = await translator.translate(original, sourceLanguage);
  if (!hasMeaningfulTranslation(original, translations)) {
    return null;
  }

  return {
    original,
    translations,
    language: detectedLanguage,
    languageLabel: languageName(detectedLanguage),
    flagged: config.enableRiskFlag
      ? shouldFlagText({
          original,
          translated: translations.join("\n"),
          extraTerms: config.extraFlaggedTerms
        })
      : false
  };
}

function formatTranslation(result) {
  const flag = result.flagged ? ":triangular_flag_on_post: " : "";
  const original = escapeBackticks(truncate(result.original, config.maxOriginalLength));
  const translated = result.translations
    .slice(0, config.maxTranslationsPerMessage)
    .map((item) => `\`${escapeBackticks(truncate(item, 280))}\``)
    .join(" / ");

  return `${flag}(${result.languageLabel}) \`${original}\` == ${translated}`;
}

async function handleMessage(message) {
  if (!shouldHandleMessage(message)) {
    return;
  }

  if (config.sourceBotIds.size === 0 && message.author?.id && !seenSourceIds.has(message.author.id)) {
    seenSourceIds.add(message.author.id);
    console.log(
      `[translate-bot] Source observed: ${message.author.tag || "unknown"} (${message.author.id}). ` +
        "Put this ID in SOURCE_BOT_IDS to only watch this bot/webhook."
    );
  }

  const texts = extractTranslatableTexts(message);
  if (texts.length === 0) {
    return;
  }

  const lines = [];
  for (const text of texts) {
    try {
      const result = await translateOne(text);
      if (result) {
        lines.push(formatTranslation(result));
      }
    } catch (error) {
      console.error(`[translate-bot] Failed to translate "${text}":`, error);
    }
  }

  if (lines.length === 0) {
    return;
  }

  const content = lines.join("\n").slice(0, 1900);
  try {
    await message.reply({
      content,
      allowedMentions: {
        repliedUser: false
      }
    });
  } catch (error) {
    console.error("[translate-bot] Reply failed; sending a plain channel message instead:", error);
    await message.channel.send({
      content,
      allowedMentions: {
        parse: []
      }
    });
  }
}

async function logRuntimeAccess(readyClient) {
  console.log(`[translate-bot] Logged in as ${readyClient.user.tag}`);
  console.log(`[translate-bot] Configured guild ${config.guildId}, channel ${config.logChannelId}`);

  let guild;
  try {
    guild = readyClient.guilds.cache.get(config.guildId) || (await readyClient.guilds.fetch(config.guildId));
  } catch (error) {
    console.error(
      `[translate-bot] Cannot see guild ${config.guildId}. ` +
        "Invite this bot application to that server, then restart the bot."
    );
    console.error(`[translate-bot] Guilds visible to this bot: ${readyClient.guilds.cache.size}`);
    for (const visibleGuild of readyClient.guilds.cache.values()) {
      console.error(`[translate-bot] - ${visibleGuild.id} ${visibleGuild.name}`);
    }
    console.error(`[translate-bot] Discord error: ${error.message}`);
    return;
  }

  let channel;
  try {
    channel = await readyClient.channels.fetch(config.logChannelId);
  } catch (error) {
    console.error(`[translate-bot] Cannot fetch channel ${config.logChannelId}: ${error.message}`);
    return;
  }

  const permissions = channel.permissionsFor(readyClient.user.id);
  const checks = [
    ["ViewChannel", PermissionsBitField.Flags.ViewChannel],
    ["SendMessages", PermissionsBitField.Flags.SendMessages],
    ["ReadMessageHistory", PermissionsBitField.Flags.ReadMessageHistory],
    ["EmbedLinks", PermissionsBitField.Flags.EmbedLinks]
  ];

  console.log(`[translate-bot] Connected to guild: ${guild.name} (${guild.id})`);
  console.log(`[translate-bot] Watching channel: ${channel.name || channel.id} (${channel.id})`);
  for (const [name, flag] of checks) {
    console.log(`[translate-bot] Permission ${name}: ${permissions?.has(flag) ? "yes" : "NO"}`);
  }
}

async function logTranslationBackendAccess() {
  const health = await translator.healthCheck();
  if (health.ok) {
    const targetStatus = health.targetAvailable ? "available" : "not listed";
    console.log(
      `[translate-bot] LibreTranslate OK at ${config.libreTranslateUrl} ` +
        `(${health.languageCount} languages, target ${config.targetLanguage}: ${targetStatus})`
    );
    return;
  }

  console.error(`[translate-bot] LibreTranslate is not reachable at ${config.libreTranslateUrl}.`);
  console.error(`[translate-bot] Reason: ${health.message}`);
  console.error("[translate-bot] Start it in another terminal/tmux session:");
  console.error("[translate-bot]   tmux new -s libretranslate");
  console.error("[translate-bot]   cd /Users/floris/Projects/Codex/1MBTranslateBot");
  console.error("[translate-bot]   npm run libretranslate");
  console.error("[translate-bot] Then detach with Ctrl-b, then d, and restart this bot.");
}

client.once(Events.ClientReady, (readyClient) => {
  void logRuntimeAccess(readyClient);
  void logTranslationBackendAccess();
  if (config.sourceBotIds.size === 0) {
    console.log("[translate-bot] SOURCE_BOT_IDS is empty; watching all bots/webhooks in that channel.");
  }
});

client.on(Events.MessageCreate, (message) => {
  void enqueue(() => handleMessage(message));
});

process.on("SIGINT", () => {
  console.log("[translate-bot] Shutting down...");
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[translate-bot] Shutting down...");
  client.destroy();
  process.exit(0);
});

client.login(config.discordToken);
