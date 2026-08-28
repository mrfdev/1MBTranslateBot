#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { format } = require("node:util");
const {
  createServiceLogManager,
  parseServiceLogOptions,
  sanitizeServiceLogText
} = require("../src/service-log");

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

function installConsoleCapture(manager) {
  console.log = (...values) => manager.stdout(sanitizeServiceLogText(format(...values)));
  console.info = console.log;
  console.debug = console.log;
  console.error = (...values) => manager.stderr(sanitizeServiceLogText(format(...values)));
  console.warn = console.error;
}

async function main() {
  const sourceRoot = path.resolve(
    process.env.TRANSLATIONBOT_PROJECT_ROOT || path.resolve(__dirname, "..")
  );
  const currentRelease = path.join(sourceRoot, ".deploy", "current");
  const resolvedRelease = await fs.realpath(currentRelease);
  const releaseName = path.basename(resolvedRelease);
  process.env.TRANSLATIONBOT_PROJECT_ROOT = sourceRoot;
  if (/^[0-9a-f]{40}$/u.test(releaseName)) {
    process.env.TRANSLATIONBOT_RELEASE = releaseName;
  }
  const fileSettings = await readLogSettings(path.join(sourceRoot, ".env"));
  const settings = Object.fromEntries(
    [...LOG_SETTING_NAMES].map((name) => [name, process.env[name] ?? fileSettings[name]])
  );
  const serviceLogs = createServiceLogManager(sourceRoot, parseServiceLogOptions(settings));
  installConsoleCapture(serviceLogs);
  process.chdir(resolvedRelease);
  require(path.join(resolvedRelease, "src", "index.js"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `TranslationBot managed startup failed: ${sanitizeServiceLogText(
        error instanceof Error ? error.message : String(error)
      )}`
    );
    process.exitCode = 1;
  });
}

module.exports = { installConsoleCapture, main, readLogSettings };
