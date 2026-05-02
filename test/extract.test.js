const assert = require("node:assert/strict");
const test = require("node:test");
const {
  extractBookTextsFromParts,
  extractTextFromCommand,
  extractSignTextsFromParts,
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

test("extracts sign text from sign spy embeds", () => {
  const parts = [
    "Placed by `FumbleHead` : `/tppos -34988 65 -35024 legacy`\n```\nFumble's\nShitter\n\n## occupied ##\n```"
  ];

  assert.deepEqual(extractSignTextsFromParts(parts), ["Fumble's\nShitter\n\n## occupied ##"]);
});

test("ignores sign spy metadata outside fenced sign text", () => {
  const parts = [
    "Placed by `Laykam` : `/tppos 8724 82 -11412 wild`\n```\nTotem fish \nMyths: 7/11\nor\nPlats: 9/55\n```"
  ];

  assert.deepEqual(extractSignTextsFromParts(parts), ["Totem fish\nMyths: 7/11\nor\nPlats: 9/55"]);
});

test("extracts book pages from book spy embeds", () => {
  const parts = [
    "`Xo9_` edited a book\n**Title:** `Untitled (unsngned)`\n**Author:** `Unknown (unsigned)`\n**Coord:** `/tppos 7923 63 3082 wild`\n```\nHow the town works:\n\nIt could have a mayor\n```\n```\nCobble for smaller plots\nIron for 6x6 - 9x9\n```"
  ];

  assert.deepEqual(extractBookTextsFromParts(parts), [
    "How the town works:\n\nIt could have a mayor",
    "Cobble for smaller plots\nIron for 6x6 - 9x9"
  ]);
});

test("extracts adjacent book page blocks", () => {
  const parts = [
    "`sedguy` edited a book\n**Title:** `Untitled (unsngned)`\n**Coord:** `/tppos -1815 58 -1085 wild`\n```\nPotion of Regen. II ``` ```arrow x62\nDiamond sword\n```"
  ];

  assert.deepEqual(extractBookTextsFromParts(parts), [
    "Potion of Regen. II",
    "arrow x62\nDiamond sword"
  ]);
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

test("flags sign profanity before translation", () => {
  assert.equal(
    shouldFlagText({
      original: "Fumble's\nShitter\n\n## occupied ##",
      translated: "",
      extraTerms: []
    }),
    true
  );
});
