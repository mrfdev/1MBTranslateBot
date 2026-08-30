const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  currentReleaseIdentity,
  parseJobState,
  parseHealthArguments,
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
const { installConsoleCapture, resolveReleaseRoot } = require("../scripts/service-runner");

test("renders a sanitized auto-starting LaunchAgent definition", async () => {
  const root = path.resolve(__dirname, "..");
  const definition = await renderServiceDefinition({
    TRANSLATIONBOT_PROJECT_ROOT: root,
    TRANSLATIONBOT_NODE: "/opt/local/bin/node"
  });
  assert.match(definition, /<string>com\.mrfdev\.translationbot<\/string>/u);
  assert.match(definition, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(definition, /<key>KeepAlive<\/key>/u);
  assert.match(definition, /\.deploy\/current\/scripts\/service-runner\.js/u);
  assert.equal(
    definition.includes(`<string>${path.join(root, "scripts", "service-runner.js")}</string>`),
    false,
    "launchd must not execute the mutable source-checkout runner"
  );
  assert.match(definition, /<key>TRANSLATIONBOT_PROJECT_ROOT<\/key>/u);
  assert.match(definition, /<key>TRANSLATIONBOT_DEPLOY_ROOT<\/key>/u);
  assert.doesNotMatch(definition, /__[A-Z0-9_]+__/u);
  assert.doesNotMatch(
    require("node:fs").readFileSync(
      path.join(root, "operations", "com.mrfdev.translationbot.plist"),
      "utf8"
    ),
    /\/(?:Users|home)\/[A-Za-z0-9._-]+/u
  );
});

test("requires and applies the release-local log sanitizer", () => {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    error: console.error,
    warn: console.warn
  };
  const stdout = [];
  const stderr = [];
  const manager = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value)
  };
  try {
    assert.throws(
      () => installConsoleCapture(manager),
      /release-local log sanitizer/u
    );
    installConsoleCapture(manager, (value) => value.replaceAll("secret", "[redacted]"));
    console.log("secret stdout");
    console.error("secret stderr");
    assert.deepEqual(stdout, ["[redacted] stdout"]);
    assert.deepEqual(stderr, ["[redacted] stderr"]);
  } finally {
    Object.assign(console, original);
  }
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

test("accepts only explicit health output and alert-test switches", () => {
  assert.deepEqual(parseHealthArguments(["--json", "--alert-test"]), {
    json: true,
    alertTest: true
  });
  assert.throws(() => parseHealthArguments(["--json", "--json"]), /repeated/u);
  assert.throws(() => parseHealthArguments(["--details"]), /Unknown/u);
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
  assert.deepEqual(parseOperation("health", ["--json", "--alert-test"]), {
    script: "operations",
    args: ["health", "--json", "--alert-test"]
  });
  assert.deepEqual(parseOperation("deploy", ["--rollback"]), {
    script: "deploy",
    args: ["--rollback"]
  });
  assert.equal(parseOperation("update", []).script, "update");
  const command = buildRemoteCommand(configuration, parseOperation("restart", []));
  assert.match(command, /translationbot-ops\.js/u);
  assert.match(command, /TRANSLATIONBOT_NODE='\/opt\/local\/bin\/node'/u);
  assert.match(command, /TRANSLATIONBOT_PROJECT_ROOT='\/srv\/private\/TranslationBot'/u);
  assert.throws(
    () => parseConfiguration('{"host":"bad host","nodePath":"/bin/node","projectRoot":"/srv/bot"}'),
    ConfigurationError
  );
  assert.throws(() => parseOperation("shell", []), /Usage/u);
  assert.throws(() => parseOperation("health", ["--verbose"]), /health argument/u);
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

test("binds the managed runner to a commit-named release directory", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "translationbot-release-test-"));
  const deployRoot = path.join(temporaryRoot, ".deploy");
  const releasesRoot = path.join(deployRoot, "releases");
  const releaseName = "a".repeat(40);
  const releaseRoot = path.join(releasesRoot, releaseName);
  const outsideRoot = path.join(temporaryRoot, "source-checkout");
  try {
    await fs.mkdir(releaseRoot, { recursive: true });
    await fs.mkdir(outsideRoot);
    await fs.symlink(path.join("releases", releaseName), path.join(deployRoot, "current"));
    assert.deepEqual(await resolveReleaseRoot(deployRoot, releaseRoot), {
      releaseName,
      resolvedRelease: await fs.realpath(releaseRoot)
    });
    await assert.rejects(
      resolveReleaseRoot(deployRoot, outsideRoot),
      /not inside a verified release directory/u
    );
    assert.equal(
      await currentReleaseIdentity({
        TRANSLATIONBOT_PROJECT_ROOT: outsideRoot,
        TRANSLATIONBOT_DEPLOY_ROOT: deployRoot
      }),
      releaseName
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
