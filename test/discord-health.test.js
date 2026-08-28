const assert = require("node:assert/strict");
const test = require("node:test");
const { MessageFlags, PermissionFlagsBits } = require("discord.js");
const {
  HEALTH_COMMAND_NAME,
  canUseHealthCommand,
  ensureHealthCommand,
  ephemeralReply,
  formatDiscordHealth,
  healthCommandDefinition,
  isHealthCommandInteraction,
  visibleProvider
} = require("../src/discord-health");
const { buildHealthSnapshot } = require("../src/health");

function snapshot() {
  return buildHealthSnapshot(
    {
      version: "1.2.3",
      release: "a".repeat(40),
      startedAt: new Date("2026-08-28T03:00:00.000Z"),
      lifecycle: "running",
      discord: {
        gateway: "ready",
        server: "available",
        command: "available",
        channels: {
          message_log: "available",
          sign_log: "available",
          book_log: "not-configured"
        }
      },
      translationMode: "active",
      backend: {
        ollama_service_available: true,
        ollama_model_available: true,
        legacy_available: null
      },
      translationMetrics: {
        active_translations: 4,
        active_unchanged: 1,
        failures: 0,
        ollama: {
          cache_entries: 2,
          cache_capacity: 100,
          cache_hits: 3,
          circuit_state: "closed",
          active: 0,
          queued: 0,
          inflight: 0
        }
      },
      messageQueue: { active: 0, queued: 0 }
    },
    new Date("2026-08-28T03:05:00.000Z")
  );
}

test("defines one guild-only Manage Server command with health and alert-test subcommands", () => {
  const definition = healthCommandDefinition();
  assert.equal(definition.name, HEALTH_COMMAND_NAME);
  assert.equal(definition.dmPermission, false);
  assert.equal(definition.defaultMemberPermissions, PermissionFlagsBits.ManageGuild);
  assert.deepEqual(
    definition.options.map((option) => option.name),
    ["health", "alert-test"]
  );
});

test("registers, updates, or preserves the guild command idempotently", async () => {
  let created = 0;
  let edited = 0;
  const guild = {
    commands: {
      async fetch() {
        return { find: () => null };
      },
      async create() {
        created += 1;
      },
      async edit() {
        edited += 1;
      }
    }
  };
  assert.equal(await ensureHealthCommand(guild), "created");
  assert.equal(created, 1);

  guild.commands.fetch = async () => ({
    find: () => ({ name: HEALTH_COMMAND_NAME, equals: () => false })
  });
  assert.equal(await ensureHealthCommand(guild), "updated");
  assert.equal(edited, 1);

  guild.commands.fetch = async () => ({
    find: () => ({ name: HEALTH_COMMAND_NAME, equals: () => true })
  });
  assert.equal(await ensureHealthCommand(guild), "available");
  assert.equal(created, 1);
  assert.equal(edited, 1);
});

test("formats bounded privacy-safe Discord health and simulated attention output", () => {
  const health = formatDiscordHealth(snapshot());
  assert.match(health, /TranslationBot health: HEALTHY/u);
  assert.match(health, /visible provider Local AI/u);
  assert.match(health, /4 translated, 1 unchanged, 0 failures/u);
  assert.doesNotMatch(health, /http|\/Users\/|\d{15,}/u);
  assert.ok(health.length < 2_000);

  const alert = formatDiscordHealth(snapshot(), { alertTest: true });
  assert.match(alert, /TranslationBot health: ATTENTION/u);
  assert.match(alert, /alert-test/u);
  assert.match(alert, /no service state was changed/u);
});

test("requires the configured guild and Manage Server permission at runtime", () => {
  const allowed = {
    guildId: "configured-guild",
    commandName: HEALTH_COMMAND_NAME,
    isChatInputCommand: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild }
  };
  assert.equal(isHealthCommandInteraction(allowed), true);
  assert.equal(canUseHealthCommand(allowed, "configured-guild"), true);
  assert.equal(canUseHealthCommand({ ...allowed, guildId: "another-guild" }, "configured-guild"), false);
  assert.equal(
    canUseHealthCommand({ ...allowed, memberPermissions: { has: () => false } }, "configured-guild"),
    false
  );
  assert.equal(isHealthCommandInteraction({ ...allowed, commandName: "another-command" }), false);
});

test("marks every command response ephemeral and disables mentions", () => {
  assert.deepEqual(ephemeralReply("safe"), {
    content: "safe",
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
  assert.equal(visibleProvider("off"), "Local dictionary");
  assert.equal(visibleProvider("shadow"), "Local dictionary (AI shadow)");
});
