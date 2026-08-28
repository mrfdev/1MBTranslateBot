#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { constants } = require("node:fs");
const { open } = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "..", ".translationbot-remote.json");
const EXPECTED_CONFIG_KEYS = ["host", "nodePath", "projectRoot"];
const MAX_CONFIG_BYTES = 16 * 1024;
const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

class UsageError extends Error {}
class ConfigurationError extends Error {}

function validateLogArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--follow" || argument === "-f") {
      continue;
    }
    if (argument === "--lines" || argument === "-n") {
      const value = args[index + 1];
      if (!/^\d+$/u.test(value ?? "") || Number(value) < 1 || Number(value) > 10_000) {
        throw new UsageError("--lines must be an integer from 1 through 10000.");
      }
      index += 1;
      continue;
    }
    throw new UsageError(`Unknown logs argument: ${argument}`);
  }
}

function parseOperation(command, args) {
  if (["install", "ollama-status", "restart", "start", "status", "stop"].includes(command)) {
    if (args.length > 0) {
      throw new UsageError(`${command} does not accept arguments.`);
    }
    return { script: "operations", args: [command] };
  }
  if (command === "update") {
    if (args.length > 0) {
      throw new UsageError("update does not accept arguments.");
    }
    return { script: "update", args: [] };
  }
  if (command === "logs") {
    validateLogArguments(args);
    return { script: "operations", args: ["logs", ...args] };
  }
  if (command === "deploy") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--rollback")) {
      throw new UsageError("deploy accepts only the optional --rollback argument.");
    }
    return { script: "deploy", args };
  }
  throw new UsageError(
    "Usage: remote <deploy [--rollback]|install|logs [--lines N] [--follow]|ollama-status|restart|start|status|stop|update>"
  );
}

function validateHost(value) {
  const pattern = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])$/u;
  if (typeof value !== "string" || value.startsWith("-") || value.length > 255 || !pattern.test(value)) {
    throw new ConfigurationError("Remote configuration has an invalid SSH destination.");
  }
  return value;
}

function validateAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length > 4_096 ||
    !path.posix.isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ConfigurationError(`Remote configuration has an invalid ${label}.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "/") {
    throw new ConfigurationError(`Remote configuration has an invalid ${label}.`);
  }
  return normalized;
}

function parseConfiguration(contents) {
  let raw;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new ConfigurationError("Remote configuration is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigurationError("Remote configuration must be a JSON object.");
  }
  const keys = Object.keys(raw).sort();
  if (keys.length !== EXPECTED_CONFIG_KEYS.length || keys.some((key, index) => key !== EXPECTED_CONFIG_KEYS[index])) {
    throw new ConfigurationError("Remote configuration must contain only host, nodePath, and projectRoot.");
  }
  return Object.freeze({
    host: validateHost(raw.host),
    nodePath: validateAbsolutePath(raw.nodePath, "Node executable path"),
    projectRoot: validateAbsolutePath(raw.projectRoot, "project path")
  });
}

async function loadConfiguration(environment = process.env) {
  const configPath = environment.TRANSLATIONBOT_REMOTE_CONFIG
    ? path.resolve(environment.TRANSLATIONBOT_REMOTE_CONFIG)
    : DEFAULT_CONFIG_PATH;
  let handle;
  try {
    handle = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new ConfigurationError(
      "Remote configuration is unavailable. Create the ignored .translationbot-remote.json file from the tracked example."
    );
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new ConfigurationError("Remote configuration must be a regular file.");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new ConfigurationError("Remote configuration must be owned by the current user.");
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new ConfigurationError("Remote configuration permissions must be owner-only (chmod 600).");
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      throw new ConfigurationError("Remote configuration is unexpectedly large.");
    }
    return parseConfiguration(await handle.readFile("utf8"));
  } finally {
    await handle.close().catch(() => {});
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function buildRemoteCommand(configuration, operation) {
  const scriptName =
    operation.script === "deploy"
      ? "deploy.js"
      : operation.script === "update"
        ? "safe-update.js"
        : "translationbot-ops.js";
  const scriptPath = path.posix.join(configuration.projectRoot, "scripts", scriptName);
  const executablePath = [
    path.posix.dirname(configuration.nodePath),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ]
    .filter((directory, index, entries) => entries.indexOf(directory) === index)
    .join(":");
  const assignments = [
    `PATH=${shellQuote(executablePath)}`,
    `TRANSLATIONBOT_NODE=${shellQuote(configuration.nodePath)}`,
    `TRANSLATIONBOT_PROJECT_ROOT=${shellQuote(configuration.projectRoot)}`
  ];
  const command = [configuration.nodePath, scriptPath, ...operation.args]
    .map(shellQuote)
    .join(" ");
  return `${assignments.join(" ")} ${command}`;
}

async function runRemote(configuration, remoteCommand, environment = process.env) {
  const ssh = environment.TRANSLATIONBOT_SSH || "/usr/bin/ssh";
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, [...SSH_OPTIONS, configuration.host, remoteCommand], {
      stdio: "inherit",
      env: environment
    });
    child.once("error", () => reject(new Error("The SSH client could not be started.")));
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`The SSH client exited with signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(args = process.argv.slice(2), environment = process.env) {
  const [command, ...rest] = args;
  const operation = parseOperation(command, rest);
  const configuration = await loadConfiguration(environment);
  process.exitCode = await runRemote(
    configuration,
    buildRemoteCommand(configuration, operation),
    environment
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`TranslationBot remote operation failed: ${error.message}`);
    process.exitCode = error instanceof UsageError ? 64 : error instanceof ConfigurationError ? 78 : 1;
  });
}

module.exports = {
  ConfigurationError,
  UsageError,
  buildRemoteCommand,
  loadConfiguration,
  main,
  parseConfiguration,
  parseOperation,
  shellQuote,
  validateAbsolutePath,
  validateHost
};
