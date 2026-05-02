const assert = require("node:assert/strict");
const test = require("node:test");
const { formatTranslation } = require("../src/format");

test("formats multiline sign translations as code blocks", () => {
  const output = formatTranslation({
    original: "je suis ici\nmais je peux\nparler un\npetit francais",
    translations: ["i'm here.\nbut i can't.\nspeak one\nsmall french"],
    languageLabel: "French",
    flagged: false
  });

  assert.equal(
    output,
    "(French)\n```text\nje suis ici\nmais je peux\nparler un\npetit francais\n```\n==\n```text\ni'm here.\nbut i can't.\nspeak one\nsmall french\n```"
  );
});
