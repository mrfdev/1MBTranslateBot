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

test("legacy provider startup executes only a pre-provisioned environment", () => {
  const launcher = read("scripts/start-libretranslate.sh");
  assert.doesNotMatch(launcher, /pip\s+install|python3\s+-m\s+venv|--upgrade/u);
  assert.match(launcher, /No pre-provisioned legacy translator was found/u);
  assert.match(launcher, /exec "\$LIBRE_VENV_DIR\/bin\/libretranslate"/u);
});

test("managed launchd bootstrap never points at source-checkout project code", () => {
  const operations = read("scripts/translationbot-ops.js");
  const runner = read("scripts/service-runner.js");
  assert.match(operations, /current", "scripts", "service-runner\.js/u);
  assert.doesNotMatch(operations, /path\.join\(root, "scripts", "service-runner\.js"\)/u);
  assert.doesNotMatch(runner, /require\("\.\.\/src\//u);
  assert.match(runner, /sanitizeServiceLogText\s*\}\s*=\s*require\(path\.join\(resolvedRelease/u);
});
