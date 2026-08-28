#!/usr/bin/env node

const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function capture(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.trim();
}

function parseAheadBehind(value) {
  const match = String(value).trim().match(/^(\d+)\s+(\d+)$/u);
  if (!match) {
    throw new Error("Git returned an invalid divergence count.");
  }
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

async function update(environment = process.env) {
  const root = environment.TRANSLATIONBOT_PROJECT_ROOT || path.resolve(__dirname, "..");
  const git = environment.TRANSLATIONBOT_GIT || "/usr/bin/git";
  const dirty = await capture(git, ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: root
  });
  if (dirty) {
    throw new Error("The source worktree is not clean; refusing to update.");
  }
  const branch = await capture(git, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: root
  });
  if (!branch) {
    throw new Error("The source checkout is detached; refusing to update.");
  }
  const upstream = await capture(
    git,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: root }
  );
  await execFileAsync(git, ["fetch", "--prune"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  const counts = parseAheadBehind(
    await capture(git, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], {
      cwd: root
    })
  );
  if (counts.ahead > 0) {
    throw new Error("The source checkout is locally ahead or diverged; refusing to update.");
  }
  if (counts.behind === 0) {
    console.log("TranslationBot source is already current.");
    return;
  }
  await execFileAsync(git, ["merge", "--ff-only", upstream], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  console.log("TranslationBot source updated by fast-forward. Run deploy to activate it.");
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error("Usage: safe-update.js");
  }
  await update();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Source update failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseAheadBehind, update };
