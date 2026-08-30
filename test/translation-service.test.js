const assert = require("node:assert/strict");
const test = require("node:test");
const { OllamaError } = require("../src/ollama-translator");
const {
  TranslationService,
  localLeaveUnchangedReason
} = require("../src/translation-service");

function decision(overrides = {}) {
  return {
    decision: "translate",
    source_language: "nl",
    confidence: 0.95,
    translation: "Can you help me with my shop?",
    reason_code: "foreign",
    ...overrides
  };
}

function activeService(ollama, options = {}) {
  return new TranslationService({
    mode: "active",
    ollama,
    targetLanguage: "en",
    minimumConfidence: 0.9,
    maxInputChars: 1_200,
    maxTranslations: 1,
    enableRiskFlag: false,
    ...options
  });
}

test("short-circuits ordinary English, proper names, game terms, commands, and ambiguous fragments", async () => {
  let calls = 0;
  const service = activeService({
    async analyze() {
      calls += 1;
      return decision();
    },
    metricsSnapshot() {
      return {};
    }
  });

  for (const text of [
    "hello there",
    "FumbleHead",
    "Netherite",
    "/warp shop",
    "x: 123 y: 64 z: -42",
    "bank",
    "🎉 123"
  ]) {
    assert.equal(await service.translate({ text, kind: "sign" }), null, text);
    assert.ok(localLeaveUnchangedReason(text), text);
  }
  assert.equal(calls, 0);
});

test("does not prefilter no-space foreign sentences or formatting-heavy mixed text", () => {
  assert.equal(
    localLeaveUnchangedReason("このチェストにダイヤモンドを入れてください。"),
    null
  );
  assert.equal(
    localLeaveUnchangedReason("%player%, ga naar &a/warp shop!"),
    null
  );
  assert.equal(
    localLeaveUnchangedReason("https://example.invalid hola amigos"),
    null
  );
});

test("accepts Dutch and other foreign translations only at or above the threshold", async () => {
  const accepted = activeService({
    analyze: async () => decision({ confidence: 0.9 }),
    metricsSnapshot: () => ({})
  });
  const acceptedResult = await accepted.translate({
    text: "Kun je mij helpen met mijn winkel",
    kind: "direct-message"
  });
  assert.deepEqual(acceptedResult.translations, ["Can you help me with my shop?"]);
  assert.equal(acceptedResult.provider, "local-ai");

  const rejected = activeService({
    analyze: async () => decision({ confidence: 0.899 }),
    metricsSnapshot: () => ({})
  });
  assert.equal(
    await rejected.translate({
      text: "Kun je mij helpen met mijn winkel",
      kind: "direct-message"
    }),
    null
  );

  const contradictoryEnglish = activeService({
    analyze: async () =>
      decision({
        source_language: "en",
        confidence: 0.99,
        translation: "Invented English rewrite"
      }),
    metricsSnapshot: () => ({})
  });
  assert.equal(
    await contradictoryEnglish.translate({
      text: "Quartz bazaar restocking shortly",
      kind: "direct-message"
    }),
    null
  );

  const mixed = activeService({
    analyze: async () =>
      decision({
        source_language: "nl",
        confidence: 0.96,
        translation: "I will come later, okay",
        reason_code: "mixed"
      }),
    metricsSnapshot: () => ({})
  });
  assert.deepEqual(
    (
      await mixed.translate({
        text: "ik kom later, okay",
        kind: "direct-message"
      })
    ).translations,
    ["I will come later, okay"]
  );
});

test("leaves input unchanged on uncertain decisions and every Ollama failure", async () => {
  const uncertain = activeService({
    analyze: async () =>
      decision({
        decision: "uncertain",
        source_language: "und",
        confidence: 0.6,
        translation: null,
        reason_code: "uncertain"
      }),
    metricsSnapshot: () => ({})
  });
  assert.equal(
    await uncertain.translate({ text: "to może być coś", kind: "sign" }),
    null
  );

  let legacyCalls = 0;
  const unavailable = activeService(
    {
      analyze: async () => {
        throw new OllamaError("service-unavailable");
      },
      metricsSnapshot: () => ({})
    },
    {
      legacy: {
        detect: async () => {
          legacyCalls += 1;
        }
      }
    }
  );
  assert.equal(
    await unavailable.translate({
      text: "een duidelijke Nederlandse boodschap",
      kind: "direct-message"
    }),
    null
  );
  assert.equal(legacyCalls, 0, "active mode must never fall back to the legacy provider");
});

test("off mode preserves the explicit local legacy path", async () => {
  let detected = 0;
  let translated = 0;
  const service = new TranslationService({
    mode: "off",
    legacy: {
      async detect() {
        detected += 1;
        return { language: "nl", confidence: 0.99 };
      },
      async translate() {
        translated += 1;
        return ["Can you help me?"];
      }
    },
    targetLanguage: "en",
    minimumDetectionConfidence: 0.5,
    enableRiskFlag: false
  });

  const result = await service.translate({
    text: "Kun je mij alsjeblieft helpen",
    kind: "direct-message"
  });
  assert.deepEqual(result.translations, ["Can you help me?"]);
  assert.equal(result.provider, "local-dictionary");
  assert.equal(detected, 1);
  assert.equal(translated, 1);
});

test("shadow mode returns legacy output without waiting for or applying Ollama", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let ollamaCalls = 0;
  let shadowSignal;
  let trackedShadow;
  const service = new TranslationService({
    mode: "shadow",
    ollama: {
      async analyze(_entry, _context, options) {
        ollamaCalls += 1;
        shadowSignal = options.signal;
        await blocked;
        return decision({ translation: "Different model output" });
      },
      metricsSnapshot: () => ({})
    },
    legacy: {
      detect: async () => ({ language: "nl", confidence: 0.99 }),
      translate: async () => ["Visible legacy output"]
    },
    targetLanguage: "en",
    minimumConfidence: 0.9,
    minimumDetectionConfidence: 0.5,
    enableRiskFlag: false
  });

  const controller = new AbortController();
  const visible = await service.translate(
    {
      text: "Dit is een lange Nederlandse boodschap",
      kind: "direct-message"
    },
    [],
    {
      signal: controller.signal,
      trackBackgroundTask(task) {
        trackedShadow = task;
      }
    }
  );
  assert.deepEqual(visible.translations, ["Visible legacy output"]);
  assert.equal(visible.provider, "local-dictionary");
  assert.equal(ollamaCalls, 1);
  assert.equal(shadowSignal, controller.signal);
  assert.ok(trackedShadow instanceof Promise);
  release();
  await service.drainShadow();
  assert.equal(service.metricsSnapshot().shadow_completed, 1);
});

test("does not count an event-cancelled shadow request as a provider failure", async () => {
  const controller = new AbortController();
  const service = new TranslationService({
    mode: "shadow",
    ollama: {
      async analyze(_entry, _context, options) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true }
          );
        });
      },
      metricsSnapshot: () => ({})
    },
    legacy: {
      detect: async () => ({ language: "nl", confidence: 0.99 }),
      translate: async () => ["Visible legacy output"]
    },
    targetLanguage: "en",
    minimumConfidence: 0.9,
    minimumDetectionConfidence: 0.5,
    enableRiskFlag: false
  });

  await service.translate(
    { text: "Dit is een lange Nederlandse boodschap", kind: "direct-message" },
    [],
    { signal: controller.signal }
  );
  controller.abort(new Error("message-time-budget"));
  await service.drainShadow();
  const metrics = service.metricsSnapshot();
  assert.equal(metrics.failures, 0);
  assert.equal(metrics.shadow_failures, 0);
  assert.equal(metrics.shadow_completed, 0);
});

test("keeps deterministic risk flags independent from translation availability", async () => {
  const service = activeService(
    {
      analyze: async () => {
        throw new OllamaError("timeout");
      },
      metricsSnapshot: () => ({})
    },
    { enableRiskFlag: true }
  );

  const result = await service.translate({
    text: "this server is fucking broken",
    kind: "sign"
  });
  assert.equal(result.flagged, true);
  assert.deepEqual(result.translations, []);
});
