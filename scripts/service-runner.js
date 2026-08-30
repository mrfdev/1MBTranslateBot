#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { format } = require("node:util");

const LOG_SETTING_NAMES = new Set([
  "SERVICE_LOG_MAX_SIZE_MB",
  "SERVICE_LOG_MAX_FILES",
  "SERVICE_LOG_MIN_FREE_MB"
]);
const MAX_ENVIRONMENT_BYTES = 256 * 1024;

async function readLogSettings(environmentPath) {
  let contents;
  try {
    const file = await fs.readFile(environmentPath);
    if (file.byteLength > MAX_ENVIRONMENT_BYTES) {
      throw new Error("The environment file is too large to inspect safely.");
    }
    contents = file.toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  const settings = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(?:"([0-9]+)"|'([0-9]+)'|([0-9]+))\s*(?:#.*)?$/u
    );
    if (match && LOG_SETTING_NAMES.has(match[1])) {
      settings[match[1]] = match[2] ?? match[3] ?? match[4];
    }
  }
  return settings;
}

function installConsoleCapture(manager, sanitizeServiceLogText) {
  if (typeof sanitizeServiceLogText !== "function") {
    throw new TypeError("A release-local log sanitizer is required.");
  }
  console.log = (...values) => manager.stdout(sanitizeServiceLogText(format(...values)));
  console.info = console.log;
  console.debug = console.log;
  console.error = (...values) => manager.stderr(sanitizeServiceLogText(format(...values)));
  console.warn = console.error;
}

async function resolveReleaseRoot(deployRoot, runnerRoot = path.resolve(__dirname, "..")) {
  const releasesRoot = await fs.realpath(path.join(deployRoot, "releases"));
  const resolvedRelease = await fs.realpath(runnerRoot);
  const releaseName = path.basename(resolvedRelease);
  if (
    path.dirname(resolvedRelease) !== releasesRoot ||
    !/^[0-9a-f]{40}$/u.test(releaseName)
  ) {
    throw new Error("The managed runner is not inside a verified release directory.");
  }
  return { releaseName, resolvedRelease };
}

async function main() {
  const sourceRoot = path.resolve(
    process.env.TRANSLATIONBOT_PROJECT_ROOT || path.resolve(__dirname, "..")
  );
  const deployRoot = path.resolve(
    process.env.TRANSLATIONBOT_DEPLOY_ROOT || path.join(sourceRoot, ".deploy")
  );
  const { releaseName, resolvedRelease } = await resolveReleaseRoot(deployRoot);
  process.env.TRANSLATIONBOT_PROJECT_ROOT = sourceRoot;
  process.env.TRANSLATIONBOT_DEPLOY_ROOT = deployRoot;
  process.env.TRANSLATIONBOT_RELEASE = releaseName;
  const {
    createServiceLogManager,
    parseServiceLogOptions,
    sanitizeServiceLogText
  } = require(path.join(resolvedRelease, "src", "service-log.js"));
  const fileSettings = await readLogSettings(path.join(sourceRoot, ".env"));
  const settings = Object.fromEntries(
    [...LOG_SETTING_NAMES].map((name) => [name, process.env[name] ?? fileSettings[name]])
  );
  const serviceLogs = createServiceLogManager(sourceRoot, parseServiceLogOptions(settings));
  installConsoleCapture(serviceLogs, sanitizeServiceLogText);
  process.chdir(resolvedRelease);
  require(path.join(resolvedRelease, "src", "index.js"));
}

if (require.main === module) {
  main().catch(() => {
    console.error("TranslationBot managed startup failed.");
    process.exitCode = 1;
  });
}

module.exports = { installConsoleCapture, main, readLogSettings, resolveReleaseRoot };
