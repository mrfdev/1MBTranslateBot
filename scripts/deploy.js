#!/usr/bin/env node

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { hasHealthyServiceLog } = require("./deploy-health");

const execFileAsync = promisify(execFile);
const scriptDirectory = __dirname;

function projectRoot(environment = process.env) {
  return environment.TRANSLATIONBOT_PROJECT_ROOT || path.resolve(scriptDirectory, "..");
}

function configuredMilliseconds(environment, name, fallback) {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 300_000) {
    throw new Error(`${name} must be an integer from 1 through 300000.`);
  }
  return Number(raw);
}

async function capture(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function atomicSymlink(linkPath, target) {
  const temporaryLink = `${linkPath}.next-${process.pid}`;
  await fs.symlink(target, temporaryLink, "dir");
  try {
    await fs.rename(temporaryLink, linkPath);
  } catch (error) {
    await fs.rm(temporaryLink, { force: true });
    throw error;
  }
}

async function readOptionalSymlink(linkPath) {
  try {
    return await fs.readlink(linkPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function validateReleaseTarget(deployRoot, releasesRoot, target) {
  const resolved = path.resolve(deployRoot, target);
  if (path.dirname(resolved) !== releasesRoot || !/^[0-9a-f]{40}$/iu.test(path.basename(resolved))) {
    throw new Error("Refusing an unsafe release link target.");
  }
}

async function logSize(logPath) {
  try {
    return (await fs.stat(logPath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function readLogSince(logPath, startingSize) {
  try {
    const contents = await fs.readFile(logPath);
    const offset = contents.length < startingSize ? 0 : startingSize;
    return contents.subarray(offset).toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function waitForHealthyService(logPath, startingSize, environment = process.env) {
  const timeout = configuredMilliseconds(
    environment,
    "TRANSLATIONBOT_HEALTH_TIMEOUT_MS",
    60_000
  );
  const interval = configuredMilliseconds(
    environment,
    "TRANSLATIONBOT_HEALTH_INTERVAL_MS",
    500
  );
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    try {
      await execFileAsync(
        environment.TRANSLATIONBOT_NODE || process.execPath,
        [path.join(scriptDirectory, "translationbot-ops.js"), "status"],
        { encoding: "utf8", env: environment }
      );
      if (hasHealthyServiceLog(await readLogSince(logPath, startingSize))) {
        return;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`TranslationBot did not become healthy within ${timeout}ms.`);
}

async function acquireDeploymentLock(lockPath) {
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another TranslationBot deployment is already running.");
    }
    throw error;
  }
}

function createOperationEnvironment(environment, ...executables) {
  const executableDirectories = executables.map((executable) => path.dirname(executable));
  const existingDirectories = (environment.PATH || "").split(path.delimiter).filter(Boolean);
  return {
    ...environment,
    PATH: [...new Set([...executableDirectories, ...existingDirectories])].join(path.delimiter)
  };
}

async function stageRelease({
  commit,
  deployRoot,
  environment,
  git,
  npm,
  releasePath,
  sourceRoot,
  tar
}) {
  if (await pathExists(releasePath)) {
    return;
  }
  const releasesRoot = path.dirname(releasePath);
  const stagingPath = path.join(releasesRoot, `${commit}.staging-${process.pid}`);
  const archivePath = path.join(deployRoot, `${commit}.archive-${process.pid}.tar`);
  await fs.mkdir(stagingPath);
  try {
    await run(git, ["archive", "--format=tar", `--output=${archivePath}`, commit], {
      cwd: sourceRoot
    });
    await run(tar, ["-xf", archivePath, "-C", stagingPath], { cwd: sourceRoot });
    await fs.rm(archivePath, { force: true });
    await run(npm, ["ci"], { cwd: stagingPath, env: environment });
    await run(npm, ["run", "check"], { cwd: stagingPath, env: environment });
    await fs.symlink(path.join(sourceRoot, ".env"), path.join(stagingPath, ".env"), "file");
    await fs.symlink(path.join(sourceRoot, "logs"), path.join(stagingPath, "logs"), "dir");
    await fs.rename(stagingPath, releasePath);
  } catch (error) {
    await fs.rm(archivePath, { force: true });
    await fs.rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function restartAndWaitForHealth(sourceRoot, serviceLogPath, environment) {
  const startingSize = await logSize(serviceLogPath);
  await run(
    environment.TRANSLATIONBOT_NODE || process.execPath,
    [path.join(scriptDirectory, "translationbot-ops.js"), "restart"],
    { cwd: sourceRoot, env: environment }
  );
  await waitForHealthyService(serviceLogPath, startingSize, environment);
}

async function deploy(environment = process.env) {
  const sourceRoot = projectRoot(environment);
  const git = environment.TRANSLATIONBOT_GIT || "/usr/bin/git";
  const node = environment.TRANSLATIONBOT_NODE || process.execPath;
  const npm = environment.TRANSLATIONBOT_NPM || "/opt/homebrew/bin/npm";
  const tar = environment.TRANSLATIONBOT_TAR || "/usr/bin/tar";
  const operationEnvironment = createOperationEnvironment(environment, node, npm, git, tar);
  const deployRoot = environment.TRANSLATIONBOT_DEPLOY_ROOT || path.join(sourceRoot, ".deploy");
  const releasesRoot = path.join(deployRoot, "releases");
  const lockPath = path.join(deployRoot, "deploy.lock");
  const currentLink = path.join(deployRoot, "current");
  const previousLink = path.join(deployRoot, "previous");
  const environmentPath = path.join(sourceRoot, ".env");
  const logsPath = path.join(sourceRoot, "logs");
  const serviceLogPath = path.join(logsPath, "translationbot-service.log");

  const status = await capture(git, ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: sourceRoot
  });
  if (status) {
    throw new Error("The source worktree is not clean; refusing to deploy.");
  }
  await fs.access(environmentPath);
  await fs.chmod(environmentPath, 0o600);
  const commit = await capture(git, ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: sourceRoot
  });
  if (!/^[0-9a-f]{40}$/iu.test(commit)) {
    throw new Error("Git did not return a full commit ID.");
  }

  await fs.mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(logsPath, { recursive: true, mode: 0o700 });
  await fs.chmod(logsPath, 0o700);
  await acquireDeploymentLock(lockPath);
  try {
    const releasePath = path.join(releasesRoot, commit);
    try {
      await stageRelease({
        commit,
        deployRoot,
        environment: operationEnvironment,
        git,
        npm,
        releasePath,
        sourceRoot,
        tar
      });
    } catch (error) {
      throw new Error(
        `Release verification failed before activation; the current release was not changed. ${error.message}`
      );
    }

    const nextTarget = path.relative(deployRoot, releasePath);
    const previousTarget = await readOptionalSymlink(currentLink);
    if (previousTarget) {
      validateReleaseTarget(deployRoot, releasesRoot, previousTarget);
    }
    const initialLogSize = await logSize(serviceLogPath);
    await run(node, [path.join(scriptDirectory, "translationbot-ops.js"), "install"], {
      cwd: sourceRoot,
      env: operationEnvironment
    });
    await atomicSymlink(currentLink, nextTarget);

    try {
      await run(node, [path.join(scriptDirectory, "translationbot-ops.js"), "restart"], {
        cwd: sourceRoot,
        env: operationEnvironment
      });
      await waitForHealthyService(serviceLogPath, initialLogSize, operationEnvironment);
      if (previousTarget && previousTarget !== nextTarget) {
        await atomicSymlink(previousLink, previousTarget);
      }
      console.log(`Deployed ${commit}.`);
    } catch (deploymentError) {
      if (!previousTarget) {
        await fs.rm(currentLink, { force: true });
        await run(node, [path.join(scriptDirectory, "translationbot-ops.js"), "stop"], {
          cwd: sourceRoot,
          env: operationEnvironment
        }).catch(() => {});
        throw new Error(
          `${deploymentError.message} No previous release was available; the service was stopped.`
        );
      }
      await atomicSymlink(currentLink, previousTarget);
      try {
        await restartAndWaitForHealth(sourceRoot, serviceLogPath, operationEnvironment);
      } catch (rollbackError) {
        throw new Error(
          `${deploymentError.message} The previous release was reselected, but rollback health verification failed: ${rollbackError.message}`
        );
      }
      throw new Error(
        `${deploymentError.message} Restored the previous release and verified it healthy.`
      );
    }
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function rollback(environment = process.env) {
  const sourceRoot = projectRoot(environment);
  const node = environment.TRANSLATIONBOT_NODE || process.execPath;
  const operationEnvironment = createOperationEnvironment(environment, node);
  const deployRoot = environment.TRANSLATIONBOT_DEPLOY_ROOT || path.join(sourceRoot, ".deploy");
  const releasesRoot = path.join(deployRoot, "releases");
  const currentLink = path.join(deployRoot, "current");
  const previousLink = path.join(deployRoot, "previous");
  const lockPath = path.join(deployRoot, "deploy.lock");
  const serviceLogPath = path.join(sourceRoot, "logs", "translationbot-service.log");

  await fs.mkdir(deployRoot, { recursive: true, mode: 0o700 });
  await acquireDeploymentLock(lockPath);
  try {
    const currentTarget = await readOptionalSymlink(currentLink);
    const previousTarget = await readOptionalSymlink(previousLink);
    if (!currentTarget || !previousTarget) {
      throw new Error("Both current and previous verified releases are required for rollback.");
    }
    validateReleaseTarget(deployRoot, releasesRoot, currentTarget);
    validateReleaseTarget(deployRoot, releasesRoot, previousTarget);
    if (currentTarget === previousTarget) {
      throw new Error("Current and previous point to the same release.");
    }
    await atomicSymlink(currentLink, previousTarget);
    try {
      await restartAndWaitForHealth(sourceRoot, serviceLogPath, operationEnvironment);
    } catch (rollbackError) {
      await atomicSymlink(currentLink, currentTarget);
      await restartAndWaitForHealth(sourceRoot, serviceLogPath, operationEnvironment);
      throw new Error(`Rollback failed: ${rollbackError.message} Restored the original release.`);
    }
    await atomicSymlink(previousLink, currentTarget);
    console.log("Rolled back to the previous verified release.");
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function main(args = process.argv.slice(2), environment = process.env) {
  if (args.length === 0) {
    await deploy(environment);
    return;
  }
  if (args.length === 1 && args[0] === "--rollback") {
    await rollback(environment);
    return;
  }
  throw new Error("Usage: deploy [--rollback]");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Deployment failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  acquireDeploymentLock,
  atomicSymlink,
  deploy,
  main,
  readOptionalSymlink,
  rollback,
  stageRelease,
  validateReleaseTarget,
  waitForHealthyService
};
