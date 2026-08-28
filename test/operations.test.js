const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  parseJobState,
  parseLogArguments,
  renderServiceDefinition,
  xmlEscape
} = require("../scripts/translationbot-ops");
const {
  ConfigurationError,
  buildRemoteCommand,
  parseConfiguration,
  parseOperation
} = require("../scripts/translationbot-remote");
const { hasHealthyServiceLog } = require("../scripts/deploy-health");
const { parseAheadBehind } = require("../scripts/safe-update");

test("renders a sanitized auto-starting LaunchAgent definition", async () => {
  const root = path.resolve(__dirname, "..");
  const definition = await renderServiceDefinition({
    TRANSLATIONBOT_PROJECT_ROOT: root,
    TRANSLATIONBOT_NODE: "/opt/local/bin/node"
  });
  assert.match(definition, /<string>com\.mrfdev\.translationbot<\/string>/u);
  assert.match(definition, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(definition, /<key>KeepAlive<\/key>/u);
  assert.match(definition, /\.deploy\/current/u);
  assert.doesNotMatch(definition, /__[A-Z0-9_]+__/u);
  assert.doesNotMatch(
    require("node:fs").readFileSync(
      path.join(root, "operations", "com.mrfdev.translationbot.plist"),
      "utf8"
    ),
    /\/(?:Users|home)\/[A-Za-z0-9._-]+/u
  );
});

test("parses launchd state without exposing the full job", () => {
  assert.deepEqual(parseJobState("state = running\n\tpid = 1234\n"), {
    state: "running",
    pid: "1234"
  });
  assert.deepEqual(parseJobState(null), { state: null, pid: null });
});

test("bounds log-viewing arguments", () => {
  assert.deepEqual(parseLogArguments(["--lines", "25", "--follow"]), {
    lines: 25,
    follow: true
  });
  assert.throws(() => parseLogArguments(["--lines", "0"]), /integer/u);
  assert.throws(() => parseLogArguments(["--unknown"]), /Unknown/u);
});

test("validates owner-local remote configuration and a narrow operation set", () => {
  const configuration = parseConfiguration(
    JSON.stringify({
      host: "private-alias",
      nodePath: "/opt/local/bin/node",
      projectRoot: "/srv/private/TranslationBot"
    })
  );
  assert.equal(parseOperation("status", []).script, "operations");
  assert.deepEqual(parseOperation("deploy", ["--rollback"]), {
    script: "deploy",
    args: ["--rollback"]
  });
  assert.equal(parseOperation("update", []).script, "update");
  assert.match(buildRemoteCommand(configuration, parseOperation("restart", [])), /translationbot-ops\.js/u);
  assert.throws(
    () => parseConfiguration('{"host":"bad host","nodePath":"/bin/node","projectRoot":"/srv/bot"}'),
    ConfigurationError
  );
  assert.throws(() => parseOperation("shell", []), /Usage/u);
});

test("escapes generated plist values and requires complete active Ollama health", () => {
  assert.equal(xmlEscape("<&\"'>"), "&lt;&amp;&quot;&apos;&gt;");
  const healthy = [
    "[translate-bot] Discord login: ready",
    "[translate-bot] Ollama mode: active",
    "[translate-bot] Ollama service: available",
    "[translate-bot] Configured Ollama model: available"
  ].join("\n");
  assert.equal(hasHealthyServiceLog(healthy), true);
  assert.equal(hasHealthyServiceLog(healthy.replace("model: available", "model: unavailable")), false);
});

test("parses safe-update divergence counts", () => {
  assert.deepEqual(parseAheadBehind("0\t3"), { ahead: 0, behind: 3 });
  assert.throws(() => parseAheadBehind("unexpected"), /invalid/u);
});
