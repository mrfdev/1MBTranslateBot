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

async function getJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    },
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
