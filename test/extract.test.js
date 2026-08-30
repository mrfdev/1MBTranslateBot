const assert = require("node:assert/strict");
const test = require("node:test");
const {
  extractBookEntries,
  extractBookEntriesFromParts,
  extractBookTextsFromParts,
  extractSignEntries,
  extractSignEntriesFromParts,
  extractTextFromCommand,
  extractSignTextsFromParts,
  extractTranslatableEntries,
  extractTranslatableEntriesFromParts,
  extractTranslatableTextsFromParts
} = require("../src/extract");
const { looksProbablyEnglish } = require("../src/language");
const {
  shouldFlagCriticalRisk,
  shouldFlagExtraTerms,
  shouldFlagText
} = require("../src/safety");

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

test("preserves the Minecraft sender and recipient for conversation context", () => {
  const parts = [
    "**MSG SPY**\nMessage by `def3ktmuzg0`, Location: `/tppos -4800 125 16800`\n`skyblock`\n```/cmi msg hellokic1a tak sie czuje lowkey```"
  ];

  assert.deepEqual(extractTranslatableEntriesFromParts(parts), [
    {
      text: "tak sie czuje lowkey",
      kind: "direct-message",
      command: "msg",
      recipient: "hellokic1a",
      actor: "def3ktmuzg0"
    }
  ]);
});

test("keeps actors isolated across batched embed records", () => {
  const message = {
    content: "",
    embeds: [
      {
        description: "Message by `Alice`\n```/cmi msg Bob cześć```"
      },
      {
        fields: [
          {
            name: "Message by `Charlie`",
            value: "```/cmi msg Dana bonjour```"
          }
        ]
      }
    ]
  };

  assert.deepEqual(extractTranslatableEntries(message), [
    {
      text: "cześć",
      kind: "direct-message",
      command: "msg",
      recipient: "Bob",
      actor: "Alice"
    },
    {
      text: "bonjour",
      kind: "direct-message",
      command: "msg",
      recipient: "Dana",
      actor: "Charlie"
    }
  ]);
});

test("keeps actors isolated across plain batched message headers", () => {
  const parts = [
    "Message by Alice\n`/cmi msg Bob hola`\nMessage by Charlie\n`/cmi msg Dana bonjour`"
  ];

  assert.deepEqual(extractTranslatableEntriesFromParts(parts), [
    {
      text: "hola",
      kind: "direct-message",
      command: "msg",
      recipient: "Bob",
      actor: "Alice"
    },
    {
      text: "bonjour",
      kind: "direct-message",
      command: "msg",
      recipient: "Dana",
      actor: "Charlie"
    }
  ]);
});

test("does not leak a detected chat actor into a separate actorless part", () => {
  const parts = [
    "Message by `RegularOne`\n`/msg FriendOne hola`\n" +
      "Message by `OtherPlayer`\n`/msg FriendTwo bonjour`",
    "`/msg FriendThree guten tag`"
  ];

  assert.deepEqual(extractTranslatableEntriesFromParts(parts), [
    {
      text: "hola",
      kind: "direct-message",
      command: "msg",
      recipient: "FriendOne",
      actor: "RegularOne"
    },
    {
      text: "bonjour",
      kind: "direct-message",
      command: "msg",
      recipient: "FriendTwo",
      actor: "OtherPlayer"
    },
    {
      text: "guten tag",
      kind: "direct-message",
      command: "msg",
      recipient: "FriendThree",
      actor: null
    }
  ]);
});

test("does not leak the first embed actor into an actorless field", () => {
  const message = {
    content: "",
    embeds: [
      {
        description:
          "Message by `RegularOne`\n`/msg FriendOne hola`\n" +
          "Message by `OtherPlayer`\n`/msg FriendTwo bonjour`",
        fields: [{ name: "Unattributed record", value: "`/msg FriendThree guten tag`" }]
      }
    ]
  };

  assert.deepEqual(extractTranslatableEntries(message), [
    {
      text: "hola",
      kind: "direct-message",
      command: "msg",
      recipient: "FriendOne",
      actor: "RegularOne"
    },
    {
      text: "bonjour",
      kind: "direct-message",
      command: "msg",
      recipient: "FriendTwo",
      actor: "OtherPlayer"
    },
    {
      text: "guten tag",
      kind: "direct-message",
      command: "msg",
      recipient: "FriendThree",
      actor: null
    }
  ]);
});

test("does not let player text spoof a structured message actor", () => {
  const message = {
    content: "",
    embeds: [
      {
        title: "Message by Alice",
        description: "`/cmi msg Bob hello Message by Charlie`"
      }
    ]
  };

  assert.deepEqual(extractTranslatableEntries(message), [
    {
      text: "hello Message by Charlie",
      kind: "direct-message",
      command: "msg",
      recipient: "Bob",
      actor: "Alice"
    }
  ]);
});

test("does not treat non-content embed metadata as a command", () => {
  const message = {
    content: "",
    embeds: [
      {
        title: "/cmi msg Bob metadata only",
        description: "Message by `Alice`"
      }
    ]
  };

  assert.deepEqual(extractTranslatableEntries(message), []);
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
  assert.equal(looksProbablyEnglish("hello there 👋"), true);
  assert.equal(looksProbablyEnglish("yes yes yes"), true);
  assert.equal(looksProbablyEnglish("Cobble for smaller plots\nIron for 6x6 - 9x9"), true);
  assert.equal(looksProbablyEnglish("Totem fish\nMyths: 7/11\nor\nPlats: 9/55"), true);
  assert.equal(looksProbablyEnglish("tak sie czuje lowkey"), false);
});

test("extracts sign text from sign spy embeds", () => {
  const parts = [
    "Placed by `FumbleHead` : `/tppos -34988 65 -35024 legacy`\n```\nFumble's\nShitter\n\n## occupied ##\n```"
  ];

  assert.deepEqual(extractSignTextsFromParts(parts), ["Fumble's\nShitter\n\n## occupied ##"]);
});

test("preserves the sign placer on sign entries", () => {
  const parts = [
    "Placed by `FumbleHead` : `/tppos -34988 65 -35024 legacy`\n```\nFumble's\nShitter\n```"
  ];

  assert.deepEqual(extractSignEntriesFromParts(parts), [
    {
      text: "Fumble's\nShitter",
      kind: "sign",
      actor: "FumbleHead"
    }
  ]);
});

test("ignores sign spy metadata outside fenced sign text", () => {
  const parts = [
    "Placed by `Laykam` : `/tppos 8724 82 -11412 wild`\n```\nTotem fish \nMyths: 7/11\nor\nPlats: 9/55\n```"
  ];

  assert.deepEqual(extractSignTextsFromParts(parts), ["Totem fish \nMyths: 7/11\nor\nPlats: 9/55"]);
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

test("preserves the book editor on every book page entry", () => {
  const parts = [
    "`Xo9_` edited a book\n**Title:** `Untitled (unsngned)`\n```\nFirst page\n```\n```\nSecond page\n```"
  ];

  assert.deepEqual(extractBookEntriesFromParts(parts), [
    {
      text: "First page",
      kind: "book-page",
      actor: "Xo9_",
      pageIndex: 0
    },
    {
      text: "Second page",
      kind: "book-page",
      actor: "Xo9_",
      pageIndex: 1
    }
  ]);
});

test("uses null actors when sign and book metadata is unknown", () => {
  assert.deepEqual(extractSignEntriesFromParts(["```\nbonjour\n```"]), [
    { text: "bonjour", kind: "sign", actor: null }
  ]);
  assert.deepEqual(extractBookEntriesFromParts(["```\nhola\n```"]), [
    { text: "hola", kind: "book-page", actor: null, pageIndex: 0 }
  ]);
});

test("does not let fenced sign or book content spoof actor metadata", () => {
  assert.equal(
    extractSignEntriesFromParts(["```\nPlaced by `SpoofedActor`\nbonjour\n```"])[0].actor,
    null
  );
  assert.equal(
    extractBookEntriesFromParts(["```\n`SpoofedActor` edited a book\nhola\n```"])[0].actor,
    null
  );

  assert.deepEqual(
    extractSignEntriesFromParts([
      "Placed by `Alice` : `/tppos 1 2 3 wild`\n```\nPlaced by `SpoofedPlayer`\nbonjour\n```"
    ]),
    [
      {
        text: "Placed by `SpoofedPlayer`\nbonjour",
        kind: "sign",
        actor: "Alice"
      }
    ]
  );

  assert.deepEqual(
    extractBookEntriesFromParts([
      "`Alice` edited a book\n```\n`SpoofedPlayer` edited a book\nhola\n```"
    ]),
    [
      {
        text: "`SpoofedPlayer` edited a book\nhola",
        kind: "book-page",
        actor: "Alice",
        pageIndex: 0
      }
    ]
  );
});

test("accepts plain markdown actor metadata variants", () => {
  assert.equal(
    extractSignEntriesFromParts(["**Placed by:** Laykam\n```\nbonjour\n```"])[0].actor,
    "Laykam"
  );
  assert.equal(
    extractBookEntriesFromParts(["**Laykam edited a book**\n```\nhola\n```"])[0].actor,
    "Laykam"
  );
});

test("keeps split sign and book actors isolated between embeds", () => {
  const signMessage = {
    content: "",
    embeds: [
      {
        description: "Placed by `Laykam` : `/tppos 1 2 3 wild`",
        fields: [{ name: "Sign text", value: "```\nbonjour\n```" }]
      },
      {
        fields: [
          {
            name: "Placed by `Alice` : `/tppos 4 5 6 wild`",
            value: "```\nhola\n```"
          }
        ]
      }
    ]
  };
  const bookMessage = {
    content: "",
    embeds: [
      {
        title: "`Laykam` edited a book",
        description: "```\npremiere page\n```"
      },
      {
        description: "`Alice` edited a book",
        fields: [{ name: "Page 1", value: "```\nsegunda pagina\n```" }]
      }
    ]
  };

  assert.deepEqual(extractSignEntries(signMessage), [
    { text: "bonjour", kind: "sign", actor: "Laykam" },
    { text: "hola", kind: "sign", actor: "Alice" }
  ]);
  assert.deepEqual(extractBookEntries(bookMessage), [
    { text: "premiere page", kind: "book-page", actor: "Laykam", pageIndex: 0 },
    { text: "segunda pagina", kind: "book-page", actor: "Alice", pageIndex: 1 }
  ]);
});

test("does not leak sign or book actors into separate actorless sources", () => {
  const signMessage = {
    content: "Placed by `Laykam` : `/tppos 1 2 3 wild`\n```\nbonjour\n```",
    embeds: [{ description: "```\nhola\n```" }]
  };
  const bookMessage = {
    content: "`Laykam` edited a book\n```\npremiere page\n```",
    embeds: [{ fields: [{ name: "Page 1", value: "```\nsegunda pagina\n```" }] }]
  };

  assert.deepEqual(extractSignEntries(signMessage), [
    { text: "bonjour", kind: "sign", actor: "Laykam" },
    { text: "hola", kind: "sign", actor: null }
  ]);
  assert.deepEqual(extractBookEntries(bookMessage), [
    { text: "premiere page", kind: "book-page", actor: "Laykam", pageIndex: 0 },
    { text: "segunda pagina", kind: "book-page", actor: null, pageIndex: 1 }
  ]);
});

test("keeps identical fenced text from different actors and deduplicates the same actor", () => {
  const signMessage = {
    content: "",
    embeds: [
      {
        description: "Placed by `Laykam` : `/tppos 1 2 3 wild`\n```\nbonjour\n```"
      },
      {
        title: "Placed by `Alice` : `/tppos 4 5 6 wild`",
        description: "```\nbonjour\n```"
      },
      {
        fields: [
          {
            name: "Placed by `Laykam` : `/tppos 7 8 9 wild`",
            value: "```\nbonjour\n```"
          }
        ]
      }
    ]
  };
  const bookMessage = {
    content: "",
    embeds: [
      { description: "`Laykam` edited a book\n```\nbonjour\n```" },
      { title: "`Alice` edited a book", description: "```\nbonjour\n```" },
      {
        fields: [
          { name: "`Laykam` edited a book", value: "```\nbonjour\n```" }
        ]
      }
    ]
  };

  assert.deepEqual(extractSignEntries(signMessage), [
    { text: "bonjour", kind: "sign", actor: "Laykam" },
    { text: "bonjour", kind: "sign", actor: "Alice" }
  ]);
  assert.deepEqual(extractBookEntries(bookMessage), [
    { text: "bonjour", kind: "book-page", actor: "Laykam", pageIndex: 0 },
    { text: "bonjour", kind: "book-page", actor: "Alice", pageIndex: 1 }
  ]);
});

test("extracts adjacent book page blocks", () => {
  const parts = [
    "`sedguy` edited a book\n**Title:** `Untitled (unsngned)`\n**Coord:** `/tppos -1815 58 -1085 wild`\n```\nPotion of Regen. II ``` ```arrow x62\nDiamond sword\n```"
  ];

  assert.deepEqual(extractBookTextsFromParts(parts), [
    "Potion of Regen. II ",
    "arrow x62\nDiamond sword"
  ]);
});

test("preserves formatting tokens, punctuation, and meaningful whitespace", () => {
  assert.equal(
    extractTextFromCommand("/cmi msg Player §a'hola'  %player%!  "),
    "§a'hola'  %player%!  "
  );
  assert.deepEqual(
    extractSignTextsFromParts(["```\n<red>hola</red>  \n§amundo\n```"]),
    ["<red>hola</red>  \n§amundo"]
  );
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

test("matches configured Unicode and symbol terms without substring false positives", () => {
  for (const term of ["блять", "死", "💣"]) {
    assert.equal(
      shouldFlagExtraTerms({ original: term, translated: "", extraTerms: [term] }),
      true
    );
  }

  assert.equal(
    shouldFlagExtraTerms({
      original: "notbadcustomwording",
      translated: "",
      extraTerms: ["badcustomword"]
    }),
    false
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

test("keeps explicit threats as deterministic critical review signals", () => {
  assert.equal(
    shouldFlagCriticalRisk({ original: "i will kill you", translated: "" }),
    true
  );
  assert.equal(
    shouldFlagCriticalRisk({ original: "ordinary conversation", translated: "" }),
    false
  );
});
