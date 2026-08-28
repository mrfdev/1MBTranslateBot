const { createHash } = require("node:crypto");
const { BoundedTtlCache } = require("./cache");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(...parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex");
}

function languageName(code) {
  if (!code) {
    return "Unknown";
  }

  try {
    const display = new Intl.DisplayNames(["en"], { type: "language" });
    return display.of(code) || code;
  } catch {
    return code;
  }
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) {
    return 0;
  }

  return confidence > 1 ? confidence / 100 : confidence;
}

async function postJson(url, body, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    const error = new Error("legacy-provider-unavailable");
    error.code = "legacy-provider-unavailable";
    throw error;
  }

  return response.json();
}

async function getJson(url, timeoutMs) {
  const response = await fetch(url, {
    redirect: "error",
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    const error = new Error("legacy-provider-unavailable");
    error.code = "legacy-provider-unavailable";
    throw error;
  }

  return response.json();
}

class LibreTranslateClient {
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.targetLanguage = options.targetLanguage;
    this.alternatives = options.alternatives;
    this.timeoutMs = options.timeoutMs;
    this.delayMs = options.delayMs;
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
      const languages = await getJson(`${this.baseUrl}/languages`, timeoutMs);
      if (!Array.isArray(languages)) {
        return {
          ok: false,
          message: "LibreTranslate responded, but /languages did not return a language list."
        };
      }

      const targetAvailable = languages.some((language) => language.code === this.targetLanguage);
      return {
        ok: true,
        languageCount: languages.length,
        targetAvailable
      };
    } catch (error) {
      return {
        ok: false,
        message: error.message
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

  async detect(text) {
    const key = cacheKey("detect", text);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const data = await postJson(
      `${this.baseUrl}/detect`,
      this.withApiKey({ q: text }),
      this.timeoutMs
    );
    const best = Array.isArray(data) ? data[0] : null;
    const result = {
      language: best?.language || "auto",
      confidence: normalizeConfidence(best?.confidence)
    };

    this.cache.set(key, result);
    return result;
  }

  async translate(text, sourceLanguage) {
    const source = sourceLanguage || "auto";
    const key = cacheKey("translate", source, this.targetLanguage, this.alternatives, text);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const data = await postJson(
      `${this.baseUrl}/translate`,
      this.withApiKey({
        q: text,
        source,
        target: this.targetLanguage,
        format: "text",
        alternatives: this.alternatives
      }),
      this.timeoutMs
    );

    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    const allTranslations = [data.translatedText, ...(Array.isArray(data.alternatives) ? data.alternatives : [])]
      .flat()
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const result = [...new Set(allTranslations)];
    this.cache.set(key, result);
    return result;
  }
}

module.exports = {
  LibreTranslateClient,
  languageName
};
