const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { extractBookTextsFromParts } = require("../src/extract");
const {
  MessageWorkBudget,
  MessageWorkLimitError,
  shouldHandleMessage
} = require("../src/message-policy");

function budget(overrides = {}) {
  return new MessageWorkBudget({
    maxInspectedChars: 10_000,
    maxCandidates: 4,
    maxCandidateChars: 4_000,
    processingBudgetMs: 10_000,
    maxOutputChars: 4_000,
    maxOutputChunks: 4,
    ...overrides
  });
}

function policy(overrides = {}) {
  return {
    guildId: "guild",
    watchedChannelIds: new Set(["logs"]),
    clientUserId: "translation-bot",
    sourceBotIds: new Set(["trusted-bot"]),
    sourceWebhookIds: new Set(["trusted-webhook"]),
    allowAnySource: false,
    translateHumanMessages: false,
    ...overrides
  };
}

test("authorizes only explicit bot and webhook identities by default", () => {
  const base = { guildId: "guild", channelId: "logs" };
  assert.equal(
    shouldHandleMessage({ ...base, author: { id: "trusted-bot", bot: true } }, policy()),
    true
  );
  assert.equal(
    shouldHandleMessage({ ...base, author: { id: "other-bot", bot: true } }, policy()),
    false
  );
  assert.equal(
    shouldHandleMessage(
      { ...base, webhookId: "trusted-webhook", author: { id: "webhook-author", bot: true } },
      policy()
    ),
    true
  );
  assert.equal(
    shouldHandleMessage(
      { ...base, webhookId: "other-webhook", author: { id: "trusted-bot", bot: true } },
      policy()
    ),
    false,
    "webhook identity must not fall back to its synthetic bot author"
  );
});

test("keeps broad sources and human messages behind separate explicit opt-ins", () => {
  const base = { guildId: "guild", channelId: "logs" };
  assert.equal(
    shouldHandleMessage(
      { ...base, author: { id: "other-bot", bot: true } },
      policy({ allowAnySource: true, sourceBotIds: new Set(), sourceWebhookIds: new Set() })
    ),
    true
  );
  assert.equal(
    shouldHandleMessage(
      { ...base, author: { id: "human", bot: false } },
      policy({ translateHumanMessages: true })
    ),
    true
  );
  assert.equal(
    shouldHandleMessage(
      { ...base, author: { id: "other-bot", bot: true } },
      policy({ translateHumanMessages: true })
    ),
    false
  );
});

test("retains guild, channel, and self-message checks", () => {
  const source = { author: { id: "trusted-bot", bot: true } };
  assert.equal(
    shouldHandleMessage({ ...source, guildId: "other", channelId: "logs" }, policy()),
    false
  );
  assert.equal(
    shouldHandleMessage({ ...source, guildId: "guild", channelId: "other" }, policy()),
    false
  );
  assert.equal(
    shouldHandleMessage(
      { guildId: "guild", channelId: "logs", author: { id: "translation-bot", bot: true } },
      policy({ sourceBotIds: new Set(["translation-bot"]) })
    ),
    false
  );
});

test("authorizes message events before they consume queue capacity", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
  const listenerStart = source.indexOf("client.on(Events.MessageCreate");
  const listenerEnd = source.indexOf("client.on(Events.InteractionCreate", listenerStart);
  const listener = source.slice(listenerStart, listenerEnd);
  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart);
  assert.ok(
    listener.indexOf("if (!shouldHandleMessage(message))") <
      listener.indexOf("messageQueue.run")
  );
});

test("stops book extraction before a fifth candidate is retained", () => {
  const work = budget({ maxCandidates: 4 });
  const input = Array.from({ length: 5 }, (_, index) => `\`\`\`\nstrona numer ${index}\n\`\`\``).join("\n");
  assert.throws(
    () => extractBookTextsFromParts([input], work),
    (error) => error instanceof MessageWorkLimitError && error.code === "message-candidate-count"
  );
  work.finish();
});

test("enforces inspection and candidate-character budgets inside the extractor", () => {
  const inspected = budget({ maxInspectedChars: 10 });
  assert.throws(
    () => extractBookTextsFromParts(["```\n" + "x".repeat(20) + "\n```"], inspected),
    (error) =>
      error instanceof MessageWorkLimitError && error.code === "message-inspection-budget"
  );
  inspected.finish();

  const candidates = budget({ maxCandidateChars: 10 });
  assert.throws(
    () => extractBookTextsFromParts(["```\n" + "x".repeat(11) + "\n```"], candidates),
    (error) =>
      error instanceof MessageWorkLimitError &&
      error.code === "message-candidate-characters"
  );
  candidates.finish();
});

test("bounds inspected, candidate, output, chunk, and send work", () => {
  const inspected = budget({ maxInspectedChars: 10 });
  assert.throws(() => inspected.inspect("x".repeat(11)), /message-inspection-budget/u);
  inspected.finish();

  const candidates = budget({ maxCandidateChars: 10 });
  assert.throws(() => candidates.addCandidate("x".repeat(11)), /message-candidate-characters/u);
  candidates.finish();

  const output = budget({ maxOutputChars: 10, maxOutputChunks: 2 });
  assert.throws(() => output.addOutput("x".repeat(11)), /message-output-budget/u);
  output.finish();

  const chunks = budget({ maxOutputChunks: 2 });
  assert.throws(() => chunks.setOutputChunks(3), /message-output-chunks/u);
  chunks.finish();

  const sends = budget({ maxOutputChunks: 2 });
  sends.addSendAttempt();
  sends.addSendAttempt();
  sends.addSendAttempt();
  assert.throws(() => sends.addSendAttempt(), /message-send-attempts/u);
  sends.finish();
});

test("aborts work when the per-event wall-clock budget expires", async () => {
  const work = budget({ processingBudgetMs: 5 });
  const keepAlive = setTimeout(() => {}, 50);
  await assert.rejects(
    work.waitFor(new Promise(() => {})),
    (error) =>
      error instanceof MessageWorkLimitError && error.code === "message-time-budget"
  );
  clearTimeout(keepAlive);
  work.finish();
});

test("keeps the event deadline active until tracked background work settles", async () => {
  const work = budget({ processingBudgetMs: 5 });
  const keepAlive = setTimeout(() => {}, 50);
  const background = work.waitFor(new Promise(() => {}));
  work.trackBackground(background);
  work.finish();
  await assert.rejects(
    background,
    (error) =>
      error instanceof MessageWorkLimitError && error.code === "message-time-budget"
  );
  clearTimeout(keepAlive);
});
