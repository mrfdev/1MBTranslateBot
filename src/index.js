const { Client, Events, GatewayIntentBits } = require("discord.js");
const { loadConfig } = require("./config");
const { extractTranslatableTexts } = require("./extract");
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

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[translate-bot] Logged in as ${readyClient.user.tag}`);
  console.log(`[translate-bot] Watching guild ${config.guildId}, channel ${config.logChannelId}`);
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
