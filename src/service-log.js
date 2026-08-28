const fs = require("node:fs");
const path = require("node:path");

const SERVICE_LOG_NAMES = Object.freeze({
  info: "translationbot-service.log",
  error: "translationbot-service.error.log"
});

const DEFAULT_SERVICE_LOG_OPTIONS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  minFreeBytes: 256 * 1024 * 1024
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function parseServiceLogOptions(environment = {}) {
  return {
    maxBytes:
      boundedInteger(environment.SERVICE_LOG_MAX_SIZE_MB, 10, 1, 1_024) * 1024 * 1024,
    maxFiles: boundedInteger(environment.SERVICE_LOG_MAX_FILES, 5, 1, 20),
    minFreeBytes:
      boundedInteger(environment.SERVICE_LOG_MIN_FREE_MB, 256, 64, 1_048_576) *
      1024 *
      1024
  };
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function removeIfPresent(filePath) {
  try {
    fs.rmSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function renameIfPresent(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function availableBytes(directory) {
  const stats = fs.statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function rotate(filePath, maxFiles) {
  removeIfPresent(`${filePath}.${maxFiles}`);
  for (let index = maxFiles; index > 1; index -= 1) {
    renameIfPresent(`${filePath}.${index - 1}`, `${filePath}.${index}`);
  }
  renameIfPresent(filePath, `${filePath}.1`);
}

function sanitizeServiceLogText(value) {
  return String(value)
    .replace(/[\r\n]+/gu, " ")
    .replace(/\/(?:Users|home)\/[^\s]+/gu, "[path]")
    .replace(/\b\d{15,22}\b/gu, "[id]")
    .replace(/\b(?:mfa\.)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}\b/gu, "[secret]")
    .slice(0, 8_192);
}

function createRotatingLogSink({
  directory,
  fileName,
  maxBytes,
  maxFiles,
  minFreeBytes,
  now = () => new Date(),
  getAvailableBytes = availableBytes
} = {}) {
  if (!path.isAbsolute(directory || "")) {
    throw new Error("The service log directory must be absolute.");
  }
  if (!Object.values(SERVICE_LOG_NAMES).includes(fileName)) {
    throw new Error("The service log file name is not allowed.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("The service log size limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error("The service log archive limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 1) {
    throw new Error("The service log disk reserve must be a positive integer.");
  }

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filePath = path.join(directory, fileName);
  let currentBytes = fileSize(filePath);
  let rotations = 0;
  let prunedArchives = 0;
  let droppedWrites = 0;
  let lastDropReason = "none";

  function protectDiskReserve(requiredBytes) {
    if (getAvailableBytes(directory) - requiredBytes >= minFreeBytes) {
      return true;
    }
    for (let index = maxFiles; index >= 1; index -= 1) {
      if (removeIfPresent(`${filePath}.${index}`)) {
        prunedArchives += 1;
      }
      if (getAvailableBytes(directory) - requiredBytes >= minFreeBytes) {
        return true;
      }
    }
    return false;
  }

  function write(value) {
    try {
      const line = `${now().toISOString()} ${sanitizeServiceLogText(value)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > maxBytes) {
        droppedWrites += 1;
        lastDropReason = "oversized-entry";
        return false;
      }
      if (!protectDiskReserve(lineBytes)) {
        droppedWrites += 1;
        lastDropReason = "disk-reserve";
        return false;
      }
      if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
        rotate(filePath, maxFiles);
        currentBytes = 0;
        rotations += 1;
      }
      fs.appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      currentBytes += lineBytes;
      lastDropReason = "none";
      return true;
    } catch {
      droppedWrites += 1;
      lastDropReason = "write-error";
      return false;
    }
  }

  return {
    write,
    getSnapshot() {
      return {
        currentBytes,
        rotations,
        prunedArchives,
        droppedWrites,
        lastDropReason
      };
    }
  };
}

function createServiceLogManager(projectRoot, options = DEFAULT_SERVICE_LOG_OPTIONS) {
  const logsDirectory = path.resolve(projectRoot, "logs");
  const common = {
    directory: logsDirectory,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    minFreeBytes: options.minFreeBytes,
    now: options.now,
    getAvailableBytes: options.getAvailableBytes
  };
  const info = createRotatingLogSink({ ...common, fileName: SERVICE_LOG_NAMES.info });
  const error = createRotatingLogSink({ ...common, fileName: SERVICE_LOG_NAMES.error });
  return {
    stdout: (line) => info.write(line),
    stderr: (line) => error.write(line),
    getSnapshot() {
      const infoSnapshot = info.getSnapshot();
      const errorSnapshot = error.getSnapshot();
      return {
        currentBytes: infoSnapshot.currentBytes + errorSnapshot.currentBytes,
        rotations: infoSnapshot.rotations + errorSnapshot.rotations,
        prunedArchives: infoSnapshot.prunedArchives + errorSnapshot.prunedArchives,
        droppedWrites: infoSnapshot.droppedWrites + errorSnapshot.droppedWrites
      };
    }
  };
}

module.exports = {
  DEFAULT_SERVICE_LOG_OPTIONS,
  SERVICE_LOG_NAMES,
  createRotatingLogSink,
  createServiceLogManager,
  parseServiceLogOptions,
  sanitizeServiceLogText
};
