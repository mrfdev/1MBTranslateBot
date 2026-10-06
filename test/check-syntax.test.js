const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkSyntax } = require("../scripts/check-syntax");

function syntaxFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "translationbot-syntax-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["src", "scripts", "test"]) {
    fs.mkdirSync(path.join(root, directory));
  }
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  return root;
}

test("checks every source directory, nested JavaScript, and shell wrappers without execution", (t) => {
  const root = syntaxFixture(t, {
    "src/a.js": "throw new Error('Syntax checking must not execute source.');\n",
    "src/nested/z.mjs": "export const valid = true;\n",
    "scripts/tool.cjs": "module.exports = true;\n",
    "scripts/start": "#!/bin/sh\nexit 9\n",
    "scripts/nested/legacy.sh": "#!/usr/bin/env bash\nvalues=(one two)\nexit 9\n",
    "test/test.js": "const valid = true;\n"
  });
  assert.deepEqual(checkSyntax(root), { javascript: 4, shell: 2 });
});

test("rejects invalid JavaScript after a valid first file", (t) => {
  const root = syntaxFixture(t, {
    "src/a.js": "const valid = true;\n",
    "src/z.js": "const = ;\n"
  });
  assert.throws(() => checkSyntax(root), /Syntax check failed for src\/z\.js/u);
});

test("rejects invalid JavaScript in nested source directories", (t) => {
  const root = syntaxFixture(t, {
    "src/a.js": "const valid = true;\n",
    "src/nested/z.js": "const = ;\n"
  });
  assert.throws(() => checkSyntax(root), /Syntax check failed for src\/nested\/z\.js/u);
});

test("rejects invalid shell syntax after a valid first wrapper", (t) => {
  const root = syntaxFixture(t, {
    "scripts/a": "#!/bin/sh\nexit 0\n",
    "scripts/z": "#!/bin/sh\nif broken\n"
  });
  assert.throws(() => checkSyntax(root), /Syntax check failed for scripts\/z/u);
});

test("rejects invalid nested Bash syntax", (t) => {
  const root = syntaxFixture(t, {
    "scripts/a": "#!/bin/sh\nexit 0\n",
    "scripts/nested/z.sh": "#!/usr/bin/env bash\nvalues=(\n"
  });
  assert.throws(() => checkSyntax(root), /Syntax check failed for scripts\/nested\/z\.sh/u);
});

test("rejects parse diagnostics under the macOS system-shell path", { skip: process.platform !== "darwin" }, (t) => {
  const root = syntaxFixture(t, {
    "scripts/nested/z.sh": "#!/usr/bin/env bash\nvalues=(\n"
  });
  const source = `require(${JSON.stringify(require.resolve("../scripts/check-syntax"))}).checkSyntax(process.argv[1]);`;
  const result = spawnSync(process.execPath, ["-e", source, root], {
    env: { ...process.env, PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Syntax check failed for scripts\/nested\/z\.sh/u);
  assert.match(result.stderr, /unexpected EOF/u);
});
