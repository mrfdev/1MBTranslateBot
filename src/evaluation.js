const { looksProbablyEnglish } = require("./language");
const {
  localLeaveUnchangedReason,
  normalizeComparable,
  safeErrorCode
} = require("./translation-service");

function legacyGateWouldTranslate(text) {
  return !looksProbablyEnglish(text);
}

function includesExpectedTerms(translation, groups = []) {
  const normalized = normalizeComparable(translation);
  return groups.every((group) => {
    const alternatives = Array.isArray(group) ? group : [group];
    return alternatives.some((term) => normalized.includes(normalizeComparable(term)));
  });
}

function preservesExpectedTokens(translation, tokens = []) {
  return tokens.every((token) => String(translation).includes(String(token)));
}

function emptySummary() {
  return {
    false_positives: 0,
    false_negatives: 0,
    predicted_translations: 0
  };
}

async function evaluateCorpus(corpus, options = {}) {
  const configuredConfidence = Number(options.minimumConfidence);
  const minimumConfidence = Number.isFinite(configuredConfidence)
    ? configuredConfidence
    : 0.9;
  const configuredMaxInput = Number(options.maxInputChars);
  const maxInputChars = Number.isFinite(configuredMaxInput) ? configuredMaxInput : 1_200;
  const legacy = emptySummary();
  const ollama = {
    ...emptySummary(),
    translation_successes: 0,
    translation_quality_failures: 0,
    errors: 0,
    error_codes: {}
  };
  const failedIds = [];
  const errorIds = [];
  const foreignCount = corpus.filter((item) => item.should_translate).length;

  for (const fixture of corpus) {
    const legacyPrediction = legacyGateWouldTranslate(fixture.text);
    if (legacyPrediction) {
      legacy.predicted_translations += 1;
    }
    if (legacyPrediction && !fixture.should_translate) {
      legacy.false_positives += 1;
    }
    if (!legacyPrediction && fixture.should_translate) {
      legacy.false_negatives += 1;
    }

    let decision = null;
    const localReason = localLeaveUnchangedReason(fixture.text, maxInputChars);
    if (localReason) {
      decision = {
        decision: "leave_unchanged",
        confidence: 1,
        translation: null,
        reason_code: localReason
      };
    } else {
      try {
        decision = await options.analyze({
          text: fixture.text,
          kind: fixture.kind || "direct-message"
        });
      } catch (error) {
        ollama.errors += 1;
        const code = safeErrorCode(error);
        ollama.error_codes[code] = (ollama.error_codes[code] || 0) + 1;
        errorIds.push(fixture.id);
        decision = {
          decision: "uncertain",
          confidence: 0,
          translation: null,
          reason_code: "uncertain"
        };
      }
    }

    const accepted =
      decision.decision === "translate" &&
      decision.confidence >= minimumConfidence &&
      Boolean(decision.translation);
    if (accepted) {
      ollama.predicted_translations += 1;
    }
    if (accepted && !fixture.should_translate) {
      ollama.false_positives += 1;
    }
    if (!accepted && fixture.should_translate) {
      ollama.false_negatives += 1;
      failedIds.push(fixture.id);
      continue;
    }
    if (!fixture.should_translate || !accepted) {
      continue;
    }

    const qualityPassed =
      includesExpectedTerms(decision.translation, fixture.expected_terms) &&
      preservesExpectedTokens(decision.translation, fixture.preserve);
    if (qualityPassed) {
      ollama.translation_successes += 1;
    } else {
      ollama.translation_quality_failures += 1;
      failedIds.push(fixture.id);
    }
  }

  const reduction = legacy.false_positives
    ? Math.round(
        ((legacy.false_positives - ollama.false_positives) / legacy.false_positives) * 100
      )
    : 0;
  return {
    fixture_count: corpus.length,
    foreign_fixture_count: foreignCount,
    legacy_gate: legacy,
    ollama_active: ollama,
    false_positive_reduction_percent: reduction,
    translation_success_percent: foreignCount
      ? Math.round((ollama.translation_successes / foreignCount) * 100)
      : 0,
    failed_ids: [...new Set(failedIds)],
    error_ids: [...new Set(errorIds)]
  };
}

module.exports = {
  evaluateCorpus,
  includesExpectedTerms,
  legacyGateWouldTranslate,
  preservesExpectedTokens
};
