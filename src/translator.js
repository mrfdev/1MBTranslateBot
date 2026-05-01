const cache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(...parts) {
  return parts.join("\u001f").toLowerCase();
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
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LibreTranslate HTTP ${response.status}: ${text.slice(0, 200)}`);
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

  async detect(text) {
    const key = cacheKey("detect", text);
    if (cache.has(key)) {
      return cache.get(key);
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

    cache.set(key, result);
    return result;
  }

  async translate(text, sourceLanguage) {
    const source = sourceLanguage || "auto";
    const key = cacheKey("translate", source, this.targetLanguage, text);
    if (cache.has(key)) {
      return cache.get(key);
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
    cache.set(key, result);
    return result;
  }
}

module.exports = {
  LibreTranslateClient,
  languageName
};
