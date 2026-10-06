#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function sourceFiles(root, directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .flatMap((entry) => {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(root, relativePath);
      }
      return entry.isFile() ? [relativePath] : [];
    });
}

function shellInterpreter(root, file) {
  const firstLine = fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/u, 1)[0];
  const match = firstLine.match(
    /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/[^\s]*\/)?(sh|bash|zsh)(?:\s|$)/u
  );
  return match?.[1] || (file.endsWith(".sh") ? "sh" : null);
}

function validate(command, args, root, file) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() ||
      `Checker exited with ${result.signal || result.status}.`;
    throw new Error(`Syntax check failed for ${file}:\n${detail}`);
  }
}

function checkSyntax(root = path.resolve(__dirname, "..")) {
  const counts = { javascript: 0, shell: 0 };
  for (const directory of ["src", "scripts", "test"]) {
    for (const file of sourceFiles(root, directory)) {
      if (/\.(?:js|cjs|mjs)$/u.test(file)) {
        validate(process.execPath, ["--check", file], root, file);
        counts.javascript += 1;
      } else if (directory === "scripts") {
        const shell = shellInterpreter(root, file);
        if (shell) {
          validate(shell, ["-n", file], root, file);
          counts.shell += 1;
        }
      }
    }
  }
  return counts;
}

if (require.main === module) {
  try {
    const counts = checkSyntax();
    console.log(`Syntax checked ${counts.javascript} JavaScript files and ${counts.shell} shell scripts.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkSyntax };
