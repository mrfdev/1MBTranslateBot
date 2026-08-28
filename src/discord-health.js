const {
  ApplicationCommandOptionType,
  MessageFlags,
  PermissionFlagsBits
} = require("discord.js");

const HEALTH_COMMAND_NAME = "translationbot";

function healthCommandDefinition() {
  return {
    name: HEALTH_COMMAND_NAME,
    description: "Check the private local TranslationBot runtime.",
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    dmPermission: false,
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "health",
        description: "Show the current privacy-safe bot health."
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "alert-test",
        description: "Simulate an attention response without changing the bot."
      }
    ]
  };
}

async function ensureHealthCommand(guild) {
  const definition = healthCommandDefinition();
  const commands = await guild.commands.fetch();
  const existing = commands.find((command) => command.name === HEALTH_COMMAND_NAME);
  if (!existing) {
    await guild.commands.create(definition);
    return "created";
  }
  if (!existing.equals(definition, true)) {
    await guild.commands.edit(existing, definition);
    return "updated";
  }
  return "available";
}

function visibleProvider(mode) {
  if (mode === "active") {
    return "Local AI";
  }
  if (mode === "shadow") {
    return "Local dictionary (AI shadow)";
  }
  if (mode === "off") {
    return "Local dictionary";
  }
  return "unknown";
}

function availability(value) {
  return value === true ? "yes" : value === false ? "no" : "not loaded";
}

function compactUptime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  return [days ? `${days}d` : "", hours || days ? `${hours}h` : "", `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

function formatDiscordHealth(snapshot, { alertTest = false } = {}) {
  const attention = new Set(snapshot.attention || []);
  if (alertTest) {
    attention.add("alert-test");
  }
  const codes = [...attention].sort();
  const status = codes.length > 0 ? "ATTENTION" : "HEALTHY";
  const marker = codes.length > 0 ? "⚠️" : "✅";
  const release = snapshot.application.release === "development"
    ? "development"
    : snapshot.application.release.slice(0, 12);
  const lines = [
    `${marker} **TranslationBot health: ${status}**`,
    `Attention required: ${codes.length > 0 ? `yes (${codes.join(", ")})` : "no"}`
  ];
  if (alertTest) {
    lines.push("This is a read-only alert simulation; no service state was changed.");
  }
  lines.push(
    `Version: ${snapshot.application.version} (${release}), uptime ${compactUptime(snapshot.application.uptime_seconds)}`,
    `Discord: gateway ${snapshot.discord.gateway}, server ${snapshot.discord.server}, slash command ${snapshot.discord.command}`,
    `Channels: messages ${snapshot.discord.channels.message_log}, signs ${snapshot.discord.channels.sign_log}, books ${snapshot.discord.channels.book_log}`,
    `Translation: ${snapshot.translation.mode}, visible provider ${visibleProvider(snapshot.translation.mode)}, Ollama ${availability(snapshot.translation.backend.ollama_service_available)}, model ${availability(snapshot.translation.backend.ollama_model_available)}, circuit ${snapshot.translation.circuit.state}`,
    `Cache: ${snapshot.translation.cache.entries}/${snapshot.translation.cache.max_entries} entries, ${snapshot.translation.cache.hits} hits`,
    `Queues: messages ${snapshot.queues.messages.active}/${snapshot.queues.messages.queued}, Ollama ${snapshot.queues.ollama.active}/${snapshot.queues.ollama.queued}/${snapshot.queues.ollama.inflight}`,
    `Activity: ${snapshot.translation.activity.translated} translated, ${snapshot.translation.activity.unchanged} unchanged, ${snapshot.translation.activity.failures} failures, repairs ${snapshot.translation.activity.repair_successes}/${snapshot.translation.activity.repair_attempts}`
  );
  return lines.join("\n");
}

function isHealthCommandInteraction(interaction) {
  return interaction.isChatInputCommand?.() && interaction.commandName === HEALTH_COMMAND_NAME;
}

function canUseHealthCommand(interaction, guildId) {
  return (
    interaction.guildId === guildId &&
    Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
  );
}

function ephemeralReply(content) {
  return {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  };
}

module.exports = {
  HEALTH_COMMAND_NAME,
  canUseHealthCommand,
  ensureHealthCommand,
  ephemeralReply,
  formatDiscordHealth,
  healthCommandDefinition,
  isHealthCommandInteraction,
  visibleProvider
};
