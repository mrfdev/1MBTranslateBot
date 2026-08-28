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

  assert.deepEqual(store.contextFor(first), []);
  store.remember(first, {
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
  assert.deepEqual(store.contextFor(reply), [
    {
      speaker: "Alice",
      original: "cześć",
      translation: "hello",
      language: "pl",
      confidence: 0.9
    }
  ]);

  assert.deepEqual(
    store.contextFor({
      text: "bonjour",
      kind: "direct-message",
      actor: "Alice",
      recipient: "Charlie"
    }),
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

  store.remember(entry, { translations: ["hello"], language: "es", confidence: 0.9 });
  now = 101;
  assert.deepEqual(store.contextFor(entry), []);
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

  store.remember(directMessage, { translations: ["hello"], language: "pl", confidence: 0.9 });

  now = 90;
  const bobReply = {
    text: "jak tam?",
    kind: "reply",
    actor: "Bob",
    recipient: null
  };
  assert.equal(store.contextFor(bobReply).length, 1);
  store.remember(bobReply, { translations: ["how are you?"], language: "pl", confidence: 0.9 });

  now = 101;
  const aliceReply = {
    text: "dobrze",
    kind: "reply",
    actor: "Alice",
    recipient: null
  };
  assert.equal(store.contextFor(aliceReply).length, 2);
});
