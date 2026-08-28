const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TextProtectionError,
  neutralizeDiscordMentions,
  protectText,
  restoreProtectedText
} = require("../src/text-protection");

test("preserves formatting, placeholders, punctuation, whitespace, URLs, and line breaks", () => {
  const original = "  §aHallo, %player%!\nGa naar https://example.invalid/path  ";
  const protection = protectText(original);
  const modelOutput = protection.text.replace("Hallo", "Hello").replace("Ga naar", "Go to");

  assert.equal(
    restoreProtectedText(modelOutput, protection, { maxOutputChars: 200 }),
    "  §aHello, %player%!\nGo to https://example.invalid/path  "
  );
  assert.doesNotMatch(protection.text, /%player%|example\.invalid|\n/u);
});

test("coalesces adjacent formatting into fewer model markers", () => {
  const protection = protectText("%player%, ga naar &a/warp shop!");
  assert.equal(protection.tokens.length, 2);
  assert.equal(
    restoreProtectedText(
      protection.text.replace("ga naar", "go to"),
      protection,
      { maxOutputChars: 100 }
    ),
    "%player%, go to &a/warp shop!"
  );
});

test("preserves MiniMessage tags, Discord tokens, and command text", () => {
  const original = "<red>hola</red> <@123456789012345678> /warp shop";
  const protection = protectText(original);
  assert.equal(
    restoreProtectedText(protection.text.replace("hola", "hello"), protection),
    "<red>hello</red> <@123456789012345678> /warp shop"
  );
});

test("rejects missing, duplicated, reordered, or invented protected tokens", () => {
  const protection = protectText("§aHola, %player%!");
  const markers = protection.tokens.map((token) => token.marker);

  for (const output of [
    `Hello${markers.join("")}${markers[0]}`,
    `Hello${[...markers].reverse().join("")}`,
    `Hello${markers.join("")}${protection.prefix}9999_QXZ`
  ]) {
    assert.throws(
      () => restoreProtectedText(output, protection),
      TextProtectionError
    );
  }

  const interior = protectText("hola %player% amigo");
  assert.throws(
    () => restoreProtectedText("hello friend", interior),
    TextProtectionError
  );
});

test("deterministically restores omitted boundary markers", () => {
  const protection = protectText("%player%, hola amigo!");
  assert.equal(
    restoreProtectedText("hello friend", protection),
    "%player%, hello friend!"
  );
});

test("restores model-rendered line breaks only when they exactly match the protected layout", () => {
  const protection = protectText("bonjour ici\nje peux parler\navec mes amis");
  assert.equal(
    restoreProtectedText("hello here\ni can speak\nwith my friends", protection),
    "hello here\ni can speak\nwith my friends"
  );
  assert.throws(
    () => restoreProtectedText("hello here\ni can speak with my friends", protection),
    (error) => error.code === "line-break-mismatch"
  );
  assert.throws(
    () => restoreProtectedText("hello here\ni can speak\nwith\nmy friends", protection),
    (error) => error.code === "line-break-mismatch"
  );
});

test("rejects model-added mentions, links, formatting, commands, and line breaks", () => {
  const protection = protectText("hola amigo");
  for (const output of [
    "hello @everyone",
    "hello https://example.invalid",
    "**hello**",
    "/ban player",
    "hello\nthere"
  ]) {
    assert.throws(
      () => restoreProtectedText(output, protection),
      TextProtectionError,
      output
    );
  }
});

test("preserves initial capitalization and enforces the output length", () => {
  const upper = protectText("Hallo wereld");
  assert.equal(restoreProtectedText("hello world", upper), "Hello world");

  const lower = protectText("hallo wereld");
  assert.equal(restoreProtectedText("Hello world", lower), "hello world");

  assert.throws(
    () => restoreProtectedText("a translated sentence", lower, { maxOutputChars: 5 }),
    (error) => error.code === "output-too-long"
  );
});

test("neutralizes Discord mention syntax without retaining any destination identity", () => {
  assert.equal(
    neutralizeDiscordMentions("hello @everyone and <@123456789012345678>"),
    "hello @\u200beveryone and <@\u200b123456789012345678>"
  );
});
