const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createPlayerNameSet,
  entryForConversationContext,
  isEntryFromIgnoredPlayer,
  normalizePlayerName,
  processEntryWithPlayerPolicy
} = require("../src/player-policy");
const { ConversationContextStore } = require("../src/context");
const {
  extractTranslatableEntries,
  extractTranslatableEntriesFromParts
} = require("../src/extract");

test("normalizes and deduplicates exact player names", () => {
  assert.equal(normalizePlayerName("  RegularOne  "), "regularone");
  assert.deepEqual(
    [...createPlayerNameSet([" RegularOne ", "REGULARONE", "Second_Player", ""])],
    ["regularone", "second_player"]
  );
});

test("ignores only entries authored by an exact configured player", () => {
  const ignoredPlayerNames = createPlayerNameSet(["RegularOne"]);

  for (const kind of ["direct-message", "reply", "action", "sign", "book-page"]) {
    assert.equal(
      isEntryFromIgnoredPlayer({ actor: "REGULARONE", kind }, ignoredPlayerNames),
      true,
      kind
    );
  }
  assert.equal(
    isEntryFromIgnoredPlayer({ actor: "RegularOne2", kind: "sign" }, ignoredPlayerNames),
    false
  );
  assert.equal(
    isEntryFromIgnoredPlayer(
      { actor: "OtherPlayer", recipient: "RegularOne", kind: "direct-message" },
      ignoredPlayerNames
    ),
    false
  );
  assert.equal(
    isEntryFromIgnoredPlayer({ actor: null, kind: "book-page" }, ignoredPlayerNames),
    false
  );
});

test("bypasses translation for ignored authors but keeps local risk review", async () => {
  const ignoredPlayerNames = createPlayerNameSet(["RegularOne"]);
  const translated = [];
  const reviewed = [];
  const translationService = {
    riskOnlyResult(text) {
      reviewed.push(text);
      return text.includes("flag locally") ? { flagged: true, original: text } : null;
    },
    async translate(entry) {
      translated.push(entry);
      return { translated: true };
    }
  };

  for (const kind of ["direct-message", "sign", "book-page"]) {
    assert.equal(
      await processEntryWithPlayerPolicy({
        entry: { actor: "REGULARONE", kind, text: `ordinary ${kind}` },
        ignoredPlayerNames,
        translationService
      }),
      null,
      kind
    );
  }

  const flagged = await processEntryWithPlayerPolicy({
    entry: { actor: "RegularOne", kind: "sign", text: "flag locally" },
    ignoredPlayerNames,
    translationService
  });
  assert.equal(flagged.flagged, true);
  assert.equal(translated.length, 0);
  assert.equal(reviewed.length, 4);

  for (const entry of [
    { actor: "OtherPlayer", kind: "direct-message", text: "translate sender" },
    {
      actor: "OtherPlayer",
      recipient: "RegularOne",
      kind: "direct-message",
      text: "translate recipient-only match"
    },
    { actor: null, kind: "book-page", text: "translate unknown editor" }
  ]) {
    assert.deepEqual(
      await processEntryWithPlayerPolicy({
        entry,
        ignoredPlayerNames,
        translationService
      }),
      { translated: true }
    );
  }

  assert.equal(translated.length, 3);
});

test("keeps ignored entries out of conversation routing and history", () => {
  const ignoredPlayerNames = createPlayerNameSet(["RegularOne"]);
  const store = new ConversationContextStore({
    maxConversations: 10,
    maxMessages: 5,
    ttlMs: 60_000
  });
  const ignored = {
    actor: "RegularOne",
    recipient: "FriendOne",
    kind: "direct-message",
    text: "ignored"
  };
  const translated = {
    actor: "OtherPlayer",
    recipient: "FriendTwo",
    kind: "direct-message",
    text: "translated"
  };

  const turns = store.beginTurns(
    [ignored, translated].map((entry) =>
      entryForConversationContext(entry, ignoredPlayerNames)
    )
  );

  assert.equal(turns[0], null);
  assert.ok(turns[1]?.key);
  assert.deepEqual(store.snapshot(), { conversations: 0, peer_routes: 2 });
});

test("applies sender policy per entry in mixed chat-log batches", async () => {
  const ignoredPlayerNames = createPlayerNameSet(["RegularOne"]);
  const entries = extractTranslatableEntriesFromParts([
    "Message by `RegularOne`\n`/msg FriendOne hola`\n" +
      "Message by `OtherPlayer`\n`/msg RegularOne bonjour`",
    "`/msg FriendTwo guten tag`"
  ]);
  const translatedActors = [];
  const reviewed = [];
  const translationService = {
    riskOnlyResult(text) {
      reviewed.push(text);
      return null;
    },
    async translate(entry) {
      translatedActors.push(entry.actor);
      return null;
    }
  };

  await Promise.all(
    entries.map((entry) =>
      processEntryWithPlayerPolicy({
        entry,
        ignoredPlayerNames,
        translationService
      })
    )
  );

  assert.deepEqual(reviewed, ["hola"]);
  assert.deepEqual(translatedActors, ["OtherPlayer", null]);
});

test("ignored usernames ending in underscores bypass translation from Discord embeds", async () => {
  const entries = extractTranslatableEntries({
    content: "",
    embeds: [
      {
        author: { name: "**MSG SPY**" },
        description:
          "Message by `Regular_`, Location: `/tppos 1 2 3 world`\n" +
          "```\n/cmi msg Friend_ ik heb twee shards```",
        fields: []
      }
    ]
  });
  const ignoredPlayerNames = createPlayerNameSet(["Regular_"]);
  let translateCalls = 0;
  let reviewCalls = 0;
  const translationService = {
    riskOnlyResult() {
      reviewCalls += 1;
      return null;
    },
    async translate() {
      translateCalls += 1;
      return null;
    }
  };

  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor, "Regular_");
  assert.equal(entries[0].recipient, "Friend_");
  await processEntryWithPlayerPolicy({
    entry: entries[0],
    ignoredPlayerNames,
    translationService
  });
  assert.equal(translateCalls, 0);
  assert.equal(reviewCalls, 1);
});
