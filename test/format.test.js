const assert = require("node:assert/strict");
const test = require("node:test");
const { formatTranslation } = require("../src/format");

test("formats multiline sign translations as code blocks", () => {
  const output = formatTranslation({
    original: "je suis ici\nmais je peux\nparler un\npetit francais",
    translations: ["i'm here.\nbut i can't.\nspeak one\nsmall french"],
    languageLabel: "French",
    provider: "local-ai",
    flagged: false
  });

  assert.equal(
    output,
    "(French • Local AI)\n```text\nje suis ici\nmais je peux\nparler un\npetit francais\n```\n==\n```text\ni'm here.\nbut i can't.\nspeak one\nsmall french\n```"
  );
});

test("includes and sanitizes a review reason with a translation", () => {
  const output = formatTranslation({
    original: "ik maak je dood",
    translations: ["I will kill you"],
    languageLabel: "Dutch",
    provider: "local-dictionary",
    flagged: true,
    note: "credible `threat`\nagainst another player"
  });

  assert.equal(
    output,
    ":triangular_flag_on_post: (Dutch • Local dictionary) `ik maak je dood` == `I will kill you`\nReview: `credible 'threat' against another player`"
  );
});

test("neutralizes mentions and markdown fences in both original and translated output", () => {
  const output = formatTranslation({
    original: "hola @everyone `now`",
    translations: ["hello <@123456789012345678> ```now```"],
    languageLabel: "Spanish",
    flagged: false
  });

  assert.doesNotMatch(output, /@everyone|<@123456789012345678>|```now```/u);
  assert.match(output, /@\u200beveryone/u);
  assert.match(output, /<@\u200b123456789012345678>/u);
});

test("forces heading metadata onto one markdown-safe line", () => {
  const output = formatTranslation({
    original: "hola",
    translations: ["hello"],
    languageLabel: "French)\n**FORGED** [review](https://example.invalid @everyone",
    provider: "local-dictionary",
    flagged: false
  });

  assert.equal(output.split("\n").length, 1);
  assert.doesNotMatch(output, /\*\*FORGED\*\*|\[review\]\(https:\/\/|@everyone/u);
  assert.match(output, /@\u200beveryone/u);
  assert.match(output, /https:\u200b\/\//u);
});
