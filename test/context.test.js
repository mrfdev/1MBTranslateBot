const assert = require("node:assert/strict");
const test = require("node:test");
const { ConversationContextStore, directMessageKey } = require("../src/context");

test("keeps context isolated by player pair and resolves replies to the last peer", () => {
  const store = new ConversationContextStore({
    maxConversations: 10,
    maxMessages: 3,
    ttlMs: 1000
  });
  const first = {
    text: "cześć",
    kind: "direct-message",
    actor: "Alice",
    recipient: "Bob"
  };

  const firstTurn = store.beginTurn(first);
  assert.deepEqual(firstTurn.context, []);
  store.remember(firstTurn, first, {
    translations: ["hello"],
    language: "pl",
    confidence: 0.9
  });

  const reply = {
    text: "jak tam?",
    kind: "reply",
    actor: "Bob",
    recipient: null
  };
  const replyTurn = store.beginTurn(reply);
  assert.deepEqual(replyTurn.context, [
    {
      speaker: "Alice",
      original: "cześć",
      translation: "hello",
      language: "pl",
      confidence: 0.9
    }
  ]);

  assert.deepEqual(
    store.beginTurn({
      text: "bonjour",
      kind: "direct-message",
      actor: "Alice",
      recipient: "Charlie"
    }).context,
    []
  );
  assert.equal(directMessageKey("Bob", "Alice"), directMessageKey("alice", "bob"));
});

test("expires conversation context", () => {
  let now = 0;
  const store = new ConversationContextStore({
    maxConversations: 10,
    maxMessages: 3,
    ttlMs: 100,
    now: () => now
  });
  const entry = {
    text: "hola",
    kind: "direct-message",
    actor: "Alice",
    recipient: "Bob"
  };

  const turn = store.beginTurn(entry);
  store.remember(turn, entry, { translations: ["hello"], language: "es", confidence: 0.9 });
  now = 101;
  assert.deepEqual(store.beginTurn(entry).context, []);
});

test("keeps reply peer resolution alive while the conversation is active", () => {
  let now = 0;
  const store = new ConversationContextStore({
    maxConversations: 10,
    maxMessages: 3,
    ttlMs: 100,
    now: () => now
  });
  const directMessage = {
    text: "cześć",
    kind: "direct-message",
    actor: "Alice",
    recipient: "Bob"
  };

  const directTurn = store.beginTurn(directMessage);
  store.remember(directTurn, directMessage, {
    translations: ["hello"],
    language: "pl",
    confidence: 0.9
  });

  now = 90;
  const bobReply = {
    text: "jak tam?",
    kind: "reply",
    actor: "Bob",
    recipient: null
  };
  const bobTurn = store.beginTurn(bobReply);
  assert.equal(bobTurn.context.length, 1);
  store.remember(bobTurn, bobReply, {
    translations: ["how are you?"],
    language: "pl",
    confidence: 0.9
  });

  now = 101;
  const aliceReply = {
    text: "dobrze",
    kind: "reply",
    actor: "Alice",
    recipient: null
  };
  assert.equal(store.beginTurn(aliceReply).context.length, 2);
});

test("keeps an in-flight reply bound to its intake-time participant pair", () => {
  const store = new ConversationContextStore({
    maxConversations: 10,
    maxMessages: 3,
    ttlMs: 1000
  });
  const bobMessage = {
    text: "cześć",
    kind: "direct-message",
    actor: "Bob",
    recipient: "Alice"
  };
  const bobTurn = store.beginTurn(bobMessage);
  store.remember(bobTurn, bobMessage, {
    translations: ["hello"],
    language: "pl",
    confidence: 0.9
  });

  const aliceReply = {
    text: "sekretna odpowiedź",
    kind: "reply",
    actor: "Alice",
    recipient: null
  };
  const inFlightTurn = store.beginTurn(aliceReply);

  const malloryMessage = {
    text: "hola",
    kind: "direct-message",
    actor: "Mallory",
    recipient: "Alice"
  };
  const malloryTurn = store.beginTurn(malloryMessage);
  store.remember(inFlightTurn, aliceReply, {
    translations: ["secret reply"],
    language: "pl",
    confidence: 0.9
  });

  assert.equal(malloryTurn.context.length, 0);
  assert.equal(store.beginTurn(malloryMessage).context.length, 0);
  assert.equal(store.beginTurn(bobMessage).context.at(-1).original, "sekretna odpowiedź");
});

test("reserves later replies in a batch before any entry can await", () => {
  const store = new ConversationContextStore({
    maxConversations: 10,
    maxMessages: 3,
    ttlMs: 1000
  });
  const bobMessage = {
    text: "cześć",
    kind: "direct-message",
    actor: "Bob",
    recipient: "Alice"
  };
  const bobTurn = store.beginTurn(bobMessage);
  store.remember(bobTurn, bobMessage, {
    translations: ["hello"],
    language: "pl",
    confidence: 0.9
  });

  const aliceReply = {
    text: "późniejsza odpowiedź",
    kind: "reply",
    actor: "Alice",
    recipient: null
  };
  const turns = store.beginTurns([
    { text: "waves", kind: "action", actor: "Alice", recipient: null },
    aliceReply
  ]);
  store.beginTurn({
    text: "hola",
    kind: "direct-message",
    actor: "Mallory",
    recipient: "Alice"
  });

  assert.equal(turns[0], null);
  assert.equal(store.contextForTurn(turns[1]).at(-1).original, "cześć");
  store.remember(turns[1], aliceReply, {
    translations: ["later reply"],
    language: "pl",
    confidence: 0.9
  });
  assert.equal(store.beginTurn(bobMessage).context.at(-1).original, "późniejsza odpowiedź");
});
