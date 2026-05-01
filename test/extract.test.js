const assert = require("node:assert/strict");
const test = require("node:test");
const {
  extractTextFromCommand,
  extractTranslatableTextsFromParts
} = require("../src/extract");
const { shouldFlagText } = require("../src/safety");

test("extracts text after cmi msg recipient", () => {
  assert.equal(
    extractTextFromCommand("/cmi msg def3ktmuzg0 jestesmt quackiem trtaz"),
    "jestesmt quackiem trtaz"
  );
});

test("extracts commands from embed-like markdown without translating metadata", () => {
  const parts = [
    "**MSG SPY**\nMessage by `def3ktmuzg0`, Location: `/tppos -4800 125 16800`\n`skyblock`\n```/cmi msg hellokic1a tak sie czuje lowkey```"
  ];

  assert.deepEqual(extractTranslatableTextsFromParts(parts), ["tak sie czuje lowkey"]);
});

test("deduplicates inline and raw command copies", () => {
  const parts = ["`/cmi msg hellokic1a postaw pochodnie`\n/cmi msg hellokic1a postaw pochodnie"];

  assert.deepEqual(extractTranslatableTextsFromParts(parts), ["postaw pochodnie"]);
});

test("flags configured extra terms", () => {
  assert.equal(
    shouldFlagText({
      original: "hello badcustomword",
      translated: "hello",
      extraTerms: ["badcustomword"]
    }),
    true
  );
});
