const { createHash } = require("node:crypto");
const { BoundedTtlCache } = require("./cache");

const LANGUAGE_CODE_PATTERN = /^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/u;
const MAX_DETECTION_ENTRIES = 32;
const MAX_LANGUAGE_ENTRIES = 256;

class LegacyProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "LegacyProviderError";
    this.code = code;
  }
}

function sleep(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cacheKey(...parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex");
}

function normalizeLanguageCode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim().toLocaleLowerCase();
  return LANGUAGE_CODE_PATTERN.test(code) ? code : null;
}

function languageName(value) {
  const code = normalizeLanguageCode(value);
  if (!code || code === "und") {
    return "Unknown";
  }

  try {
    const display = new Intl.DisplayNames(["en"], { type: "language" });
    return display.of(code) || code;
  } catch {
    return "Unknown";
  }
}

function normalizeConfidence(value) {
  if (typeof value !== "number") {
    return 0;
  }
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) {
    return 0;
  }

  const normalized = confidence > 1 ? confidence / 100 : confidence;
  return Math.max(0, Math.min(1, normalized));
}

function requestSignal(timeoutMs, externalSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

async function readBoundedJson(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new LegacyProviderError("legacy-response-too-large");
  }

  let text;
  if (!response.body?.getReader) {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new LegacyProviderError("legacy-response-too-large");
    }
  } else {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new LegacyProviderError("legacy-response-too-large");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    text = Buffer.concat(chunks).toString("utf8");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new LegacyProviderError("legacy-invalid-json");
  }
}

async function postJson(fetchImpl, url, body, timeoutMs, maxResponseBytes, externalSignal) {
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body),
    signal: requestSignal(timeoutMs, externalSignal)
  });

  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new LegacyProviderError("legacy-provider-unavailable");
  }

  return readBoundedJson(response, maxResponseBytes);
}

async function getJson(fetchImpl, url, timeoutMs, maxResponseBytes, externalSignal) {
  const response = await fetchImpl(url, {
    redirect: "error",
    headers: {
      Accept: "application/json"
    },
    signal: requestSignal(timeoutMs, externalSignal)
  });

  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new LegacyProviderError("legacy-provider-unavailable");
  }

  return readBoundedJson(response, maxResponseBytes);
}

class LibreTranslateClient {
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.targetLanguage = options.targetLanguage;
    this.alternatives = options.alternatives;
    this.timeoutMs = options.timeoutMs;
    this.delayMs = options.delayMs;
    this.maxResponseBytes = options.maxResponseBytes || 65_536;
    this.maxOutputChars = options.maxOutputChars || 600;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.cache =
      options.cache ||
      new BoundedTtlCache({
        maxEntries: options.cacheMaxEntries,
        ttlMs: options.cacheTtlMs
      });
  }

  withApiKey(body) {
    if (!this.apiKey) {
      return body;
    }

    return {
      ...body,
      api_key: this.apiKey
    };
  }

  async healthCheck() {
    const timeoutMs = Math.min(this.timeoutMs, 5000);

    try {
      const languages = await getJson(
        this.fetch,
        `${this.baseUrl}/languages`,
        timeoutMs,
        this.maxResponseBytes
      );
      if (
        !Array.isArray(languages) ||
        languages.length > MAX_LANGUAGE_ENTRIES ||
        languages.some(
          (language) =>
            !language ||
            typeof language !== "object" ||
            !normalizeLanguageCode(language.code)
        )
      ) {
        return {
          ok: false,
          message: "LibreTranslate responded, but /languages did not return a language list."
        };
      }

      const targetAvailable = languages.some(
        (language) => normalizeLanguageCode(language.code) === this.targetLanguage
      );
      return {
        ok: true,
        languageCount: languages.length,
        targetAvailable
      };
    } catch (error) {
      return {
        ok: false,
        message: error?.code || "legacy-provider-unavailable"
      };
    }
  }

  metricsSnapshot() {
    return {
      cache_entries: this.cache.size,
      cache_capacity: this.cache.maxEntries,
      cache_ttl_ms: this.cache.ttlMs
    };
  }

  async detect(text, options = {}) {
    const key = cacheKey("detect", text);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const data = await postJson(
      this.fetch,
      `${this.baseUrl}/detect`,
      this.withApiKey({ q: text }),
      this.timeoutMs,
      this.maxResponseBytes,
      options.signal
    );
    if (
      !Array.isArray(data) ||
      data.length === 0 ||
      data.length > MAX_DETECTION_ENTRIES ||
      data.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          !normalizeLanguageCode(entry.language) ||
          typeof entry.confidence !== "number" ||
          !Number.isFinite(entry.confidence) ||
          entry.confidence < 0 ||
          entry.confidence > 100
      )
    ) {
      throw new LegacyProviderError("legacy-invalid-response");
    }
    const best = Array.isArray(data) ? data[0] : null;
    const language = normalizeLanguageCode(best?.language);
    const result = {
      language: language || "auto",
      confidence: language ? normalizeConfidence(best?.confidence) : 0
    };

    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    this.cache.set(key, result);
    return result;
  }

  async translate(text, sourceLanguage, options = {}) {
    const source = sourceLanguage || "auto";
    const key = cacheKey("translate", source, this.targetLanguage, this.alternatives, text);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const data = await postJson(
      this.fetch,
      `${this.baseUrl}/translate`,
      this.withApiKey({
        q: text,
        source,
        target: this.targetLanguage,
        format: "text",
        alternatives: this.alternatives
      }),
      this.timeoutMs,
      this.maxResponseBytes,
      options.signal
    );

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new LegacyProviderError("legacy-invalid-response");
    }
    const primary = Array.isArray(data.translatedText)
      ? data.translatedText
      : [data.translatedText];
    const alternatives = data.alternatives === undefined ? [] : data.alternatives;
    if (primary.length === 0 || !Array.isArray(alternatives)) {
      throw new LegacyProviderError("legacy-invalid-response");
    }
    if (primary.length + alternatives.length > this.alternatives + 1) {
      throw new LegacyProviderError("legacy-too-many-translations");
    }
    if (
      primary.some((item) => typeof item !== "string" || !item.trim()) ||
      alternatives.some((item) => typeof item !== "string" || !item.trim())
    ) {
      throw new LegacyProviderError("legacy-invalid-response");
    }
    if (
      primary.some((item) => item.length > this.maxOutputChars) ||
      alternatives.some((item) => item.length > this.maxOutputChars)
    ) {
      throw new LegacyProviderError("legacy-translation-too-large");
    }
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    if (this.delayMs > 0) {
      await sleep(this.delayMs, options.signal);
    }
    const allTranslations = [...primary, ...alternatives];
    const normalizedTranslations = allTranslations.map((item) => item.trim()).filter(Boolean);
    const result = [...new Set(normalizedTranslations)];
    this.cache.set(key, result);
    return result;
  }
}

module.exports = {
  LegacyProviderError,
  LibreTranslateClient,
  languageName,
  normalizeLanguageCode
};
