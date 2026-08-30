const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LegacyProviderError,
  LibreTranslateClient,
  languageName,
  normalizeLanguageCode
} = require("../src/translator");

function client(fetchImpl, overrides = {}) {
  return new LibreTranslateClient({
    baseUrl: "http://127.0.0.1:5000",
    apiKey: "",
    targetLanguage: "en",
    alternatives: 2,
    timeoutMs: 1_000,
    delayMs: 0,
    maxResponseBytes: 4_096,
    maxOutputChars: 100,
    cacheMaxEntries: 10,
    cacheTtlMs: 10_000,
    fetchImpl,
    ...overrides
  });
}

test("accepts conservative language codes and never echoes invalid labels", () => {
  assert.equal(normalizeLanguageCode("NL"), "nl");
  assert.equal(normalizeLanguageCode("pt-BR"), "pt-br");
  assert.equal(normalizeLanguageCode(["nl"]), null);
  assert.equal(normalizeLanguageCode("French)\n**FORGED**"), null);
  assert.equal(languageName("fr"), "French");
  assert.equal(languageName("und"), "Unknown");
  assert.equal(languageName("French)\n**FORGED**"), "Unknown");
});

test("rejects invalid legacy detection metadata before caching or use", async () => {
  const legacy = client(async () => {
    return new Response(
      JSON.stringify([{ language: "French)\n**FORGED**", confidence: 99 }]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  await assert.rejects(
    legacy.detect("bonjour tout le monde"),
    (error) => error instanceof LegacyProviderError && error.code === "legacy-invalid-response"
  );
  assert.equal(legacy.metricsSnapshot().cache_entries, 0);

  for (const body of [
    [],
    [{ language: "nl", confidence: "0.9" }],
    [{ language: "nl", confidence: 0.9 }, "malformed-tail"]
  ]) {
    const malformed = client(async () => new Response(JSON.stringify(body), { status: 200 }));
    await assert.rejects(
      malformed.detect("een Nederlandse boodschap"),
      (error) =>
        error instanceof LegacyProviderError && error.code === "legacy-invalid-response"
    );
    assert.equal(malformed.metricsSnapshot().cache_entries, 0);
  }
});

test("rejects declared and streamed legacy responses above the byte budget", async () => {
  const declared = client(
    async () =>
      new Response(JSON.stringify([{ language: "nl", confidence: 0.9 }]), {
        status: 200,
        headers: { "content-length": "500" }
      }),
    { maxResponseBytes: 64 }
  );
  await assert.rejects(
    declared.detect("een Nederlandse boodschap"),
    (error) => error instanceof LegacyProviderError && error.code === "legacy-response-too-large"
  );

  const streamed = client(
    async () => new Response(JSON.stringify({ translatedText: "x".repeat(200) }), { status: 200 }),
    { maxResponseBytes: 64 }
  );
  await assert.rejects(
    streamed.translate("een Nederlandse boodschap", "nl"),
    (error) => error instanceof LegacyProviderError && error.code === "legacy-response-too-large"
  );
});

test("rejects excessive or oversized alternatives before cache insertion", async () => {
  const excessive = client(async () =>
    new Response(
      JSON.stringify({ translatedText: "one", alternatives: ["two", "three", "four"] }),
      { status: 200 }
    )
  );
  await assert.rejects(
    excessive.translate("een Nederlandse boodschap", "nl"),
    (error) =>
      error instanceof LegacyProviderError && error.code === "legacy-too-many-translations"
  );
  assert.equal(excessive.metricsSnapshot().cache_entries, 0);

  const oversized = client(
    async () => new Response(JSON.stringify({ translatedText: "x".repeat(101) }), { status: 200 }),
    { maxOutputChars: 100 }
  );
  await assert.rejects(
    oversized.translate("een Nederlandse boodschap", "nl"),
    (error) =>
      error instanceof LegacyProviderError && error.code === "legacy-translation-too-large"
  );
  assert.equal(oversized.metricsSnapshot().cache_entries, 0);

  const missingPrimary = client(async () =>
    new Response(
      JSON.stringify({ translatedText: "", alternatives: ["fallback-only"] }),
      { status: 200 }
    )
  );
  await assert.rejects(
    missingPrimary.translate("een Nederlandse boodschap", "nl"),
    (error) => error instanceof LegacyProviderError && error.code === "legacy-invalid-response"
  );
  assert.equal(missingPrimary.metricsSnapshot().cache_entries, 0);
});

test("preserves primary-first deduplication and bounded cache hits", async () => {
  let calls = 0;
  const legacy = client(async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ translatedText: "hello", alternatives: ["hi", "hello"] }),
      { status: 200 }
    );
  });

  assert.deepEqual(await legacy.translate("een Nederlandse boodschap", "nl"), ["hello", "hi"]);
  assert.deepEqual(await legacy.translate("een Nederlandse boodschap", "nl"), ["hello", "hi"]);
  assert.equal(calls, 1);
});

test("interrupts configured provider delay when the event budget is aborted", async () => {
  const controller = new AbortController();
  const reason = new Error("message-time-budget");
  controller.abort(reason);
  const legacy = client(
    async () => new Response(JSON.stringify({ translatedText: "hello" }), { status: 200 }),
    { delayMs: 1_000 }
  );

  await assert.rejects(
    legacy.translate("een Nederlandse boodschap", "nl", { signal: controller.signal }),
    (error) => error === reason
  );
  assert.equal(legacy.metricsSnapshot().cache_entries, 0);
});

test("treats oversized or malformed health language lists as unavailable", async () => {
  const oversized = client(async () =>
    new Response(
      JSON.stringify(
        Array.from({ length: 257 }, (_, index) => ({ code: index === 0 ? "en" : "nl" }))
      ),
      { status: 200 }
    )
  );
  assert.equal((await oversized.healthCheck()).ok, false);

  const malformed = client(async () => new Response(JSON.stringify([{ code: "bad code" }]), { status: 200 }));
  assert.equal((await malformed.healthCheck()).ok, false);
});
