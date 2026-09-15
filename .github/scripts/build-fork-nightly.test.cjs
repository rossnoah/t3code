const assert = require("node:assert/strict");
const test = require("node:test");
const { runCommand, runParallel } = require("./build-fork-nightly.cjs");

test("starts checks and packaging concurrently, waiting for both before publishing", async () => {
  const checks = Promise.withResolvers();
  const packaging = Promise.withResolvers();
  const bothStarted = Promise.withResolvers();
  let started = 0;
  let published = false;
  const task = (completion) => async () => {
    if (++started === 2) bothStarted.resolve();
    await completion.promise;
  };
  const run = runParallel([task(checks), task(packaging)]).then(() => {
    published = true;
  });
  await bothStarted.promise;
  assert.equal(started, 2);
  packaging.resolve();
  await packaging.promise;
  assert.equal(published, false);
  checks.resolve();
  await run;
  assert.equal(published, true);
});

for (const failedTask of [0, 1]) {
  test(`task ${failedTask} failure blocks publishing and drains the other task`, async () => {
    const other = Promise.withResolvers();
    const failed = Promise.withResolvers();
    let drained = false;
    let published = false;
    const tasks = [
      async () => {
        failed.resolve();
        throw new Error("failed");
      },
      async () => {
        await other.promise;
        drained = true;
      },
    ];
    if (failedTask === 1) tasks.reverse();
    const run = runParallel(tasks).then(() => {
      published = true;
    });
    const rejected = assert.rejects(run, (error) => {
      assert.equal(drained, true);
      assert.equal(error.errors[0].message, "failed");
      return true;
    });
    await failed.promise;
    assert.equal(published, false);
    other.resolve();
    await rejected;
    assert.equal(published, false);
  });
}

test("process errors and nonzero exits fail the build", async () => {
  await runCommand(process.execPath, ["-e", "process.exit(0)"]);
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(7)"]), /failed \(7\)/);
  await assert.rejects(runCommand("/nonexistent/t3-fork-build-command", []), { code: "ENOENT" });
});
