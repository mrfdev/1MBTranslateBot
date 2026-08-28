function hasHealthyServiceLog(contents) {
  const text = String(contents || "");
  if (!text.includes("[translate-bot] Discord login: ready")) {
    return false;
  }
  if (text.includes("[translate-bot] Ollama mode: active")) {
    return (
      text.includes("[translate-bot] Ollama service: available") &&
      text.includes("[translate-bot] Configured Ollama model: available")
    );
  }
  if (text.includes("[translate-bot] Ollama mode: shadow")) {
    return (
      text.includes("[translate-bot] Ollama service: available") &&
      text.includes("[translate-bot] Configured Ollama model: available") &&
      text.includes("[translate-bot] Legacy local translator: available")
    );
  }
  return (
    text.includes("[translate-bot] Ollama mode: off") &&
    text.includes("[translate-bot] Legacy local translator: available")
  );
}

module.exports = { hasHealthyServiceLog };
