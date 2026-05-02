const assert = require("node:assert/strict");
const test = require("node:test");
const {
  extractTextFromCommand,
  extractTranslatableTextsFromParts
} = require("../src/extract");
const { looksProbablyEnglish } = require("../src/language");
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

test("deduplicates command copies with leftover code fences", () => {
  const parts = [
    "```/cmi msg mrflores je peux parler francais comment ca va ?```",
    "/cmi msg mrflores je peux parler francais comment ca va ?```"
  ];

  assert.deepEqual(extractTranslatableTextsFromParts(parts), [
    "je peux parler francais comment ca va ?"
  ]);
});

test("does not parse fenced code again from raw markdown fallback", () => {
  const parts = ["```/cmi msg buildingkingdoms blah blah blah this is english```"];

  assert.deepEqual(extractTranslatableTextsFromParts(parts), ["blah blah blah this is english"]);
});

test("recognizes obvious English without asking the translation API", () => {
  assert.equal(looksProbablyEnglish("blah blah blah this is english"), true);
  assert.equal(looksProbablyEnglish("tak sie czuje lowkey"), false);
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

test("flags built-in English profanity before translation", () => {
  assert.equal(
    shouldFlagText({
      original: "this server is shit all in english with fucking profanity",
      translated: "",
      extraTerms: []
    }),
    true
  );
});
