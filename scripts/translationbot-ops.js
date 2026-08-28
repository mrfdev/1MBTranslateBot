#!/usr/bin/env node

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  HealthSnapshotError,
  evaluateHealth,
  readHealthSnapshot
} = require("../src/health");
const { SERVICE_LOG_NAMES } = require("../src/service-log");

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "com.mrfdev.translationbot";

function projectRoot(environment = process.env) {
  return environment.TRANSLATIONBOT_PROJECT_ROOT || path.resolve(__dirname, "..");
}

function launchdDomain(environment = process.env) {
  const uid = environment.TRANSLATIONBOT_UID || String(process.getuid());
  return `gui/${uid}`;
}

function launchdTarget(environment = process.env) {
  return `${launchdDomain(environment)}/${SERVICE_LABEL}`;
}

function launchctlPath(environment = process.env) {
  return environment.TRANSLATIONBOT_LAUNCHCTL || "/bin/launchctl";
}

function installedPlistPath(environment = process.env) {
  const directory =
    environment.TRANSLATIONBOT_LAUNCH_AGENTS_DIR ||
    path.join(os.homedir(), "Library", "LaunchAgents");
  return path.join(directory, `${SERVICE_LABEL}.plist`);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function renderServiceDefinition(environment = process.env) {
  const root = path.resolve(projectRoot(environment));
  const node = environment.TRANSLATIONBOT_NODE || process.execPath;
  if (!path.isAbsolute(node)) {
    throw new Error("The configured Node executable must be absolute.");
  }
  const executablePath = [
    ...new Set([path.dirname(node), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
  ].join(path.delimiter);
  const templatePath = path.join(root, "operations", `${SERVICE_LABEL}.plist`);
  let template = await fs.readFile(templatePath, "utf8");
  const replacements = {
    __NODE_EXECUTABLE__: node,
    __SERVICE_RUNNER__: path.join(root, "scripts", "service-runner.js"),
    __WORKING_DIRECTORY__: path.join(root, ".deploy", "current"),
    __EXECUTABLE_PATH__: executablePath
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!template.includes(placeholder)) {
      throw new Error("The service definition template is incomplete.");
    }
    template = template.replaceAll(placeholder, xmlEscape(value));
  }
  if (/__[A-Z0-9_]+__/u.test(template)) {
    throw new Error("The service definition contains an unresolved placeholder.");
  }
  return template;
}

async function installServiceDefinition({ announce = true, environment = process.env } = {}) {
  const destination = installedPlistPath(environment);
  const temporary = `${destination}.tmp-${process.pid}`;
  const definition = await renderServiceDefinition(environment);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, definition, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  if (announce) {
    console.log("TranslationBot service definition installed.");
  }
}

function configuredMilliseconds(environment, name, fallback) {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 60_000) {
    throw new Error(`${name} must be an integer from 1 through 60000.`);
  }
  return Number(raw);
}

async function readLaunchdJob(environment = process.env) {
  try {
    const { stdout } = await execFileAsync(
      launchctlPath(environment),
      ["print", launchdTarget(environment)],
      { encoding: "utf8" }
    );
    return stdout;
  } catch (error) {
    if (typeof error?.code === "number") {
      return null;
    }
    throw error;
  }
}

function parseJobState(job) {
  return {
    state: job?.match(/^\s*state\s*=\s*(\S+)/mu)?.[1] || null,
    pid: job?.match(/^\s*pid\s*=\s*(\d+)/mu)?.[1] || null
  };
}

async function reportStatus(environment = process.env) {
  const { state, pid } = parseJobState(await readLaunchdJob(environment));
  if (state === "running" && pid) {
    console.log(`TranslationBot is running (pid ${pid}).`);
    return true;
  }
  console.log("TranslationBot is stopped.");
  process.exitCode = 3;
  return false;
}

async function waitForRunningJob(environment = process.env) {
  const timeout = configuredMilliseconds(
    environment,
    "TRANSLATIONBOT_START_TIMEOUT_MS",
    15_000
  );
  const interval = configuredMilliseconds(
    environment,
    "TRANSLATIONBOT_START_INTERVAL_MS",
    100
  );
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const { state, pid } = parseJobState(await readLaunchdJob(environment));
    if (state === "running" && pid) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`launchd accepted the job, but it was not running within ${timeout}ms.`);
}

async function waitForUnloadedJob(environment = process.env) {
  const timeout = configuredMilliseconds(
    environment,
    "TRANSLATIONBOT_STOP_TIMEOUT_MS",
    30_000
  );
  const interval = configuredMilliseconds(
    environment,
    "TRANSLATIONBOT_STOP_INTERVAL_MS",
    100
  );
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    if (!(await readLaunchdJob(environment))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`launchd accepted the stop request, but the job remained loaded after ${timeout}ms.`);
}

async function startService({ announce = true, environment = process.env } = {}) {
  const currentJob = await readLaunchdJob(environment);
  if (parseJobState(currentJob).state === "running") {
    if (announce) {
      console.log("TranslationBot is already running.");
    }
    return;
  }
  if (currentJob) {
    await execFileAsync(launchctlPath(environment), ["kickstart", launchdTarget(environment)], {
      encoding: "utf8"
    });
  } else {
    const plist = installedPlistPath(environment);
    await fs.access(plist);
    await execFileAsync(
      launchctlPath(environment),
      ["bootstrap", launchdDomain(environment), plist],
      { encoding: "utf8" }
    );
  }
  await waitForRunningJob(environment);
  if (announce) {
    console.log("TranslationBot started.");
  }
}

async function stopService({ announce = true, environment = process.env } = {}) {
  if (!(await readLaunchdJob(environment))) {
    if (announce) {
      console.log("TranslationBot is already stopped.");
    }
    return;
  }
  await execFileAsync(launchctlPath(environment), ["bootout", launchdTarget(environment)], {
    encoding: "utf8"
  });
  await waitForUnloadedJob(environment);
  if (announce) {
    console.log("TranslationBot stopped.");
  }
}

async function restartService(environment = process.env) {
  await installServiceDefinition({ announce: false, environment });
  await stopService({ announce: false, environment });
  await startService({ announce: false, environment });
  console.log("TranslationBot restarted.");
}

function parseLogArguments(args) {
  let follow = false;
  let lines = 100;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--follow" || argument === "-f") {
      follow = true;
      continue;
    }
    if (argument === "--lines" || argument === "-n") {
      const value = args[index + 1];
      if (!/^\d+$/u.test(value ?? "") || Number(value) < 1 || Number(value) > 10_000) {
        throw new Error("--lines must be an integer from 1 through 10000.");
      }
      lines = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown logs argument: ${argument}`);
  }
  return { follow, lines };
}

function parseHealthArguments(args) {
  const options = { json: false, alertTest: false };
  for (const argument of args) {
    if (argument === "--json" && !options.json) {
      options.json = true;
      continue;
    }
    if (argument === "--alert-test" && !options.alertTest) {
      options.alertTest = true;
      continue;
    }
    throw new Error(`Unknown or repeated health argument: ${argument}`);
  }
  return options;
}

async function currentReleaseIdentity(environment = process.env) {
  const root = path.resolve(projectRoot(environment));
  const current = path.join(root, ".deploy", "current");
  let target;
  try {
    target = await fs.readlink(current);
  } catch (error) {
    if (["EINVAL", "ENOENT"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
  const resolved = path.resolve(path.dirname(current), target);
  const releasesDirectory = path.join(root, ".deploy", "releases");
  const release = path.basename(resolved).toLocaleLowerCase();
  return path.dirname(resolved) === releasesDirectory && /^[0-9a-f]{40}$/u.test(release)
    ? release
    : null;
}

function healthMaxAgeMs(snapshot) {
  const heartbeat = Number(snapshot?.application?.heartbeat_interval_ms);
  if (!Number.isFinite(heartbeat)) {
    return 90_000;
  }
  return Math.max(15_000, Math.min(600_000, Math.round(heartbeat * 3)));
}

function availability(value) {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  return [days ? `${days}d` : "", hours || days ? `${hours}h` : "", `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

function printHumanHealth(report) {
  console.log(`TranslationBot health: ${report.status.toLocaleUpperCase()}`);
  console.log(
    `Attention required: ${report.attention_required ? `yes (${report.attention.join(", ")})` : "no"}`
  );
  console.log(`launchd: ${report.status === "unavailable" ? "stopped" : "running"}`);
  const snapshot = report.snapshot;
  if (!snapshot) {
    console.log("Snapshot: unavailable");
    return;
  }

  const release = snapshot.application.release === "development"
    ? "development"
    : snapshot.application.release.slice(0, 12);
  console.log(
    `Application: v${snapshot.application.version}, release ${release}, uptime ${formatUptime(snapshot.application.uptime_seconds)}`
  );
  console.log(
    `Discord: gateway ${snapshot.discord.gateway}, server ${snapshot.discord.server}, message ${snapshot.discord.channels.message_log}, signs ${snapshot.discord.channels.sign_log}, books ${snapshot.discord.channels.book_log}`
  );
  console.log(
    `Translation: ${snapshot.translation.mode}, Ollama service ${availability(snapshot.translation.backend.ollama_service_available)}, model ${availability(snapshot.translation.backend.ollama_model_available)}, dictionary ${availability(snapshot.translation.backend.legacy_available)}, circuit ${snapshot.translation.circuit.state}`
  );
  console.log(
    `Cache: ${snapshot.translation.cache.entries}/${snapshot.translation.cache.max_entries} entries, ${snapshot.translation.cache.hits} hits, TTL ${snapshot.translation.cache.ttl_ms}ms`
  );
  console.log(
    `Queues: messages ${snapshot.queues.messages.active} active/${snapshot.queues.messages.queued} queued; Ollama ${snapshot.queues.ollama.active} active/${snapshot.queues.ollama.queued} queued/${snapshot.queues.ollama.inflight} inflight`
  );
  console.log(
    `Activity: ${snapshot.translation.activity.translated} translated, ${snapshot.translation.activity.unchanged} unchanged, ${snapshot.translation.activity.failures} failures, ${snapshot.translation.activity.average_latency_ms}ms average provider latency`
  );
  console.log(
    `Context: ${snapshot.context.conversations} conversations, ${snapshot.context.peer_routes} peer routes; memory ${snapshot.application.rss_mb}MB; snapshot age ${report.snapshot_age_seconds}s`
  );
}

async function reportHealth(args = [], environment = process.env) {
  const options = parseHealthArguments(args);
  const job = parseJobState(await readLaunchdJob(environment));
  let snapshot = null;
  let snapshotError = null;
  try {
    snapshot = readHealthSnapshot(projectRoot(environment));
  } catch (error) {
    if (!(error instanceof HealthSnapshotError)) {
      throw error;
    }
    snapshotError = error;
  }
  const report = evaluateHealth({
    snapshot,
    snapshotError,
    jobRunning: job.state === "running" && Boolean(job.pid),
    expectedRelease: await currentReleaseIdentity(environment),
    maxAgeMs: healthMaxAgeMs(snapshot),
    alertTest: options.alertTest
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanHealth(report);
  }
  return report;
}

async function runWithInheritedOutput(command, args, environment = process.env, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: environment, cwd });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${path.basename(command)} exited with ${signal ? `signal ${signal}` : `status ${code}`}.`)
      );
    });
  });
}

async function displayLogs(args, environment = process.env) {
  const { follow, lines } = parseLogArguments(args);
  const logsDirectory = path.join(projectRoot(environment), "logs");
  const candidates = Object.values(SERVICE_LOG_NAMES).map((name) => path.join(logsDirectory, name));
  const existing = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      existing.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (existing.length === 0) {
    throw new Error("No TranslationBot service logs exist yet.");
  }
  const tailArguments = ["-n", String(lines)];
  if (follow) {
    tailArguments.push("-F");
  }
  tailArguments.push(...existing);
  await runWithInheritedOutput(environment.TRANSLATIONBOT_TAIL || "/usr/bin/tail", tailArguments, environment);
}

async function reportOllamaStatus(environment = process.env) {
  await runWithInheritedOutput(
    environment.TRANSLATIONBOT_NODE || process.execPath,
    [path.join(projectRoot(environment), "scripts", "ollama-status.js")],
    environment,
    projectRoot(environment)
  );
}

async function main(args = process.argv.slice(2), environment = process.env) {
  const [command, ...rest] = args;
  if (!["logs", "health"].includes(command) && rest.length > 0) {
    throw new Error(`${command || "operation"} does not accept arguments.`);
  }
  if (command === "status") {
    await reportStatus(environment);
  } else if (command === "health") {
    const report = await reportHealth(rest, environment);
    process.exitCode = report.exit_code;
  } else if (command === "ollama-status") {
    await reportOllamaStatus(environment);
  } else if (command === "start") {
    await startService({ environment });
  } else if (command === "stop") {
    await stopService({ environment });
  } else if (command === "restart") {
    await restartService(environment);
  } else if (command === "logs") {
    await displayLogs(rest, environment);
  } else if (command === "install") {
    await installServiceDefinition({ environment });
  } else {
    throw new Error(
      "Usage: translationbot-ops.js <health [--json] [--alert-test]|install|logs|ollama-status|restart|start|status|stop>"
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`TranslationBot operation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  SERVICE_LABEL,
  displayLogs,
  installServiceDefinition,
  launchdDomain,
  launchdTarget,
  main,
  currentReleaseIdentity,
  healthMaxAgeMs,
  parseJobState,
  parseHealthArguments,
  parseLogArguments,
  printHumanHealth,
  projectRoot,
  renderServiceDefinition,
  reportHealth,
  reportStatus,
  restartService,
  startService,
  stopService,
  xmlEscape
};
