const { spawn } = require("node:child_process");

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: "inherit", env: options.env });
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
  // Cache reuse is a packaging instruction. Tests must exercise both build
  // paths using their own configuration, independent of this runner's cache.
  const env = { ...process.env };
  delete env.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR;
  const runCheck = (command, args) => runCommand(command, args, { env });
  await runCheck("node", [
    "--test",
    ".github/scripts/fork-nightly.test.cjs",
    ".github/scripts/fork-stack.test.cjs",
    ".github/scripts/build-fork-nightly.test.cjs",
  ]);
  await runCheck("vp", [
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
    "apps/web/vite/reactCompiler.test.ts",
    "apps/web/src/queuedMessageStore.test.ts",
    "apps/web/src/components/chat/ComposerPrimaryActions.test.tsx",
    "apps/web/src/components/ThreadNotificationCoordinator.test.tsx",
    "apps/web/src/state/desktopUpdateInstall.test.ts",
    "apps/web/src/state/desktopUpdateInstallController.test.ts",
    "apps/web/src/components/desktopUpdate.logic.test.ts",
    "apps/web/src/components/desktopUpdate.toast.test.tsx",
    "apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx",
    "apps/web/src/projectScripts.test.ts",
    "apps/web/src/components/projectScriptEditor.test.tsx",
    "packages/contracts/src/projectScript.test.ts",
    "apps/server/src/project/ProjectSetupScriptRunner.test.ts",
    "scripts/build-desktop-artifact.test.ts",
  ]);
  await runCheck("vp", [
    "test",
    "run",
    "apps/server/src/vcs/GitVcsDriverCore.test.ts",
    "-t",
    "worktree operations",
  ]);
  // Install once before desktop tests import Electron from parallel workers.
  await runCheck("node", ["apps/desktop/scripts/ensure-electron-runtime.mjs"]);
  await runCheck("vp", [
    "test",
    "run",
    "apps/desktop/src/updates/DesktopUpdates.test.ts",
    "apps/desktop/src/updates/DesktopRemoteUpdates.test.ts",
  ]);
  await runCheck("vp", [
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

module.exports = { runCommand, runParallel, checkFork };
