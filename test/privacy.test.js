const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("tracked runtime configuration contains no private IDs, usernames, or host paths", () => {
  const contents = [
    read(".env.example"),
    read("README.md"),
    ...fs
      .readdirSync(path.join(root, "src"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => read(path.join("src", name))),
    ...fs
      .readdirSync(path.join(root, "scripts"))
      .map((name) => read(path.join("scripts", name)))
  ].join("\n");

  assert.doesNotMatch(contents, /\/(?:Users|home)\/[A-Za-z0-9._-]+/u);
  assert.doesNotMatch(contents, /(?:private-hostname|operator-workstation)/iu);
  assert.doesNotMatch(read(".env.example"), /^[A-Z_]*(?:GUILD|CHANNEL|BOT)_ID=\d{12,}$/mu);
});

test("the production dependency set contains no AI or cloud provider SDK", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ["discord.js", "dotenv"]);
  assert.doesNotMatch(
    JSON.stringify(packageJson.dependencies),
    /openai|gemini|groq|anthropic|ollama/iu
  );
});

test("runtime logging does not interpolate message text or raw model responses", () => {
  const runtime = [read("src/index.js"), read("src/ollama-translator.js")].join("\n");
  assert.doesNotMatch(
    runtime,
    /console\.(?:log|warn|error)\([^\n]*\$\{(?:entry\.text|original|translation|prompt|message\.content)/u
  );
  assert.doesNotMatch(runtime, /console\.(?:log|warn|error)\([^\n]*\$\{[^}]*response/u);
});

test("both local HTTP services are constrained to loopback", () => {
  assert.doesNotMatch(read("scripts/start-libretranslate.sh"), /0\.0\.0\.0/u);
  assert.match(read("src/config.js"), /normalizeLoopbackOllamaBaseUrl/u);
  assert.match(read("src/ollama-translator.js"), /LOCAL_HOSTS/u);
});
