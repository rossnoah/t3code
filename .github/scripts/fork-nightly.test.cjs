const assert = require("node:assert/strict");
const test = require("node:test");
const { latestNightly, sourceMarker, nightlyVersion, plan } = require("./fork-nightly.cjs");
const forkSha = "a".repeat(40);
const upstreamSha = "b".repeat(40);
const release = {
  tag_name: "v0.0.41-nightly.20260915.1735",
  published_at: "2026-09-15T02:00:00Z",
  draft: false,
};

test("selects published nightlies by publication time, ignoring stable, preview and draft releases", () => {
  assert.equal(
    latestNightly([
      { ...release, tag_name: "v0.0.41" },
      { ...release, draft: true },
      { ...release, tag_name: "v0.0.41-preview.20260915.1" },
      { ...release, published_at: "2026-09-14T02:00:00Z" },
      release,
    ]),
    release,
  );
});

test("keeps the upstream base version and advances app versions on retries", () => {
  assert.equal(
    nightlyVersion(release.tag_name, release.published_at, 12, 1),
    "0.0.41-nightly.20260915.1201",
  );
  assert.equal(
    nightlyVersion(release.tag_name, release.published_at, 12, 2),
    "0.0.41-nightly.20260915.1202",
  );
  assert.throws(() => nightlyVersion("v0.0.41", release.published_at, 12, 1));
  assert.throws(() => sourceMarker("main", upstreamSha));
});

for (const scenario of [
  { name: "first release", previous: [], force: false, build: "true" },
  {
    name: "unchanged source",
    previous: [{ ...release, body: sourceMarker(forkSha, upstreamSha) }],
    force: false,
    build: "false",
  },
  {
    name: "new upstream",
    previous: [{ ...release, body: sourceMarker(forkSha, "c".repeat(40)) }],
    force: false,
    build: "true",
  },
  {
    name: "new fork changes",
    previous: [{ ...release, body: sourceMarker("c".repeat(40), upstreamSha) }],
    force: false,
    build: "true",
  },
  {
    name: "manual rebuild",
    previous: [{ ...release, body: sourceMarker(forkSha, upstreamSha) }],
    force: true,
    build: "true",
  },
]) {
  test(scenario.name, async () => {
    const outputs = {};
    const priorAttempt = process.env.GITHUB_RUN_ATTEMPT;
    process.env.GITHUB_RUN_ATTEMPT = "1";
    try {
      await plan({
        github: {
          rest: {
            repos: {
              listReleases: async ({ owner }) => ({
                data: owner === "pingdotgg" ? [release] : scenario.previous,
              }),
              getCommit: async () => ({ data: { sha: upstreamSha } }),
            },
          },
        },
        context: { repo: { owner: "rossnoah", repo: "t3code" }, sha: forkSha, runNumber: 12 },
        core: {
          setOutput: (key, value) => {
            outputs[key] = value;
          },
          info() {},
        },
        force: scenario.force,
        now: release.published_at,
      });
      assert.equal(outputs.build, scenario.build);
      assert.equal(outputs.upstream_sha, upstreamSha);
    } finally {
      if (priorAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
      else process.env.GITHUB_RUN_ATTEMPT = priorAttempt;
    }
  });
}
