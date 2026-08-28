const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateCorpus,
  includesExpectedTerms,
  preservesExpectedTokens
} = require("../src/evaluation");

test("reports false positives, false negatives, and translation quality separately", async () => {
  const corpus = [
    {
      id: "english",
      text: "Enchanting setup on the second floor",
      should_translate: false
    },
    {
      id: "dutch",
      text: "Kun je mij helpen met mijn winkel",
      should_translate: true,
      expected_terms: [["help"], ["shop", "store"]]
    },
    {
      id: "formatted",
      text: "%player%, ga naar de winkel!",
      should_translate: true,
      expected_terms: [["go"], ["shop"]],
      preserve: ["%player%", ",", "!"]
    }
  ];
  const result = await evaluateCorpus(corpus, {
    minimumConfidence: 0.9,
    analyze: async ({ text }) => {
      if (text.startsWith("Enchanting")) {
        return {
          decision: "leave_unchanged",
          source_language: "en",
          confidence: 0.99,
          translation: null,
          reason_code: "english"
        };
      }
      return {
        decision: "translate",
        source_language: "nl",
        confidence: 0.95,
        translation: text.startsWith("%player%")
          ? "%player%, go to the shop!"
          : "Can you help me with my shop",
        reason_code: "foreign"
      };
    }
  });

  assert.equal(result.legacy_gate.false_positives, 1);
  assert.equal(result.ollama_active.false_positives, 0);
  assert.equal(result.ollama_active.false_negatives, 0);
  assert.equal(result.ollama_active.translation_successes, 2);
  assert.equal(result.translation_success_percent, 100);
  assert.equal(result.false_positive_reduction_percent, 100);
});

test("translation quality checks accept alternatives and require protected tokens", () => {
  assert.equal(
    includesExpectedTerms("Please close the door", [["close", "shut"], ["door"]]),
    true
  );
  assert.equal(includesExpectedTerms("Open it", [["close", "shut"]]), false);
  assert.equal(preservesExpectedTokens("Hello %player%!", ["%player%", "!"]), true);
  assert.equal(preservesExpectedTokens("Hello player", ["%player%"]), false);
});
