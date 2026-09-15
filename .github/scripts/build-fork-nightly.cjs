const { spawn } = require("node:child_process");

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      console.log(
        `[fork-build] ${command} ${args.join(" ")}: ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

// Drain both tasks even on failure. The following publish step is reachable
// only after every check and the signed package have succeeded.
async function runParallel(tasks) {
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Fork build failed",
    );
}

async function checkFork() {
  await runCommand("node", [
    "--test",
    ".github/scripts/fork-nightly.test.cjs",
    ".github/scripts/build-fork-nightly.test.cjs",
  ]);
  await runCommand("vp", [
    "test",
    "run",
    "packages/shared/src/git.test.ts",
    "packages/shared/src/projectSettings.test.ts",
    "packages/contracts/src/settings.test.ts",
    "apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts",
    "apps/server/src/orchestration/Layers/CheckpointReactor.test.ts",
    "apps/web/src/components/GitActionsControl.logic.test.ts",
    "apps/web/src/modelOrdering.test.ts",
    "apps/web/src/components/settings/ProviderModelsSection.test.ts",
    "scripts/build-desktop-artifact.test.ts",
  ]);
  await runCommand("vp", [
    "test",
    "run",
    "apps/server/src/server.test.ts",
    "-t",
    "bootstraps first-send worktree turns",
  ]);
}

async function main() {
  const { BUILD_TARGET: target, VERSION: version } = process.env;
  if (
    !["zip", "dmg"].includes(target) ||
    !/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(version ?? "")
  ) {
    throw new Error("Expected a nightly VERSION and zip or dmg BUILD_TARGET");
  }
  await runParallel([
    checkFork,
    () =>
      runCommand("vp", [
        "run",
        "dist:desktop:artifact",
        "--platform",
        "mac",
        "--arch",
        "arm64",
        "--target",
        target,
        "--signed",
        "--skip-build",
        "--verbose",
        "--build-version",
        version,
      ]),
  ]);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runCommand, runParallel };
