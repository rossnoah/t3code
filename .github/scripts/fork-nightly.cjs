const NIGHTLY_TAG = /^v(\d+\.\d+\.\d+)-nightly\.\d{8}\.\d+$/;

function latestNightly(releases) {
  return releases
    .filter(
      (release) => !release.draft && release.published_at && NIGHTLY_TAG.test(release.tag_name),
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

function sourceMarker(forkSha, upstreamSha) {
  if (![forkSha, upstreamSha].every((sha) => /^[0-9a-f]{40}$/.test(sha))) {
    throw new Error("Expected full commit SHAs for the fork and upstream.");
  }
  return `<!-- fork-nightly: ${forkSha} ${upstreamSha} -->`;
}

function nightlyVersion(upstreamTag, now, runNumber, runAttempt) {
  const match = NIGHTLY_TAG.exec(upstreamTag);
  if (
    !match ||
    !Number.isSafeInteger(runNumber) ||
    runNumber < 1 ||
    !Number.isInteger(runAttempt) ||
    runAttempt < 1 ||
    runAttempt > 99
  ) {
    throw new Error("Invalid nightly version inputs.");
  }
  const date = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  // Rerunning a failed/published workflow must not reuse its app version.
  return `${match[1]}-nightly.${date}.${runNumber * 100 + runAttempt}`;
}

async function plan({ github, context, core, force, now = Date.now() }) {
  const upstream = { owner: "pingdotgg", repo: "t3code" };
  const [upstreamReleases, forkReleases] = await Promise.all([
    github.rest.repos.listReleases({ ...upstream, per_page: 100 }),
    github.rest.repos.listReleases({ ...context.repo, per_page: 100 }),
  ]);
  const release = latestNightly(upstreamReleases.data);
  if (!release) throw new Error("No published upstream nightly found.");
  const { data: commit } = await github.rest.repos.getCommit({
    ...upstream,
    ref: release.tag_name,
  });
  const marker = sourceMarker(context.sha, commit.sha);
  const previous = latestNightly(forkReleases.data);
  const shouldBuild = force || !previous?.body?.includes(marker);
  core.setOutput("build", String(shouldBuild));
  core.setOutput("upstream_sha", commit.sha);
  core.setOutput("upstream_tag", release.tag_name);
  core.setOutput("upstream_url", release.html_url);
  core.setOutput(
    "version",
    nightlyVersion(
      release.tag_name,
      now,
      context.runNumber,
      Number(process.env.GITHUB_RUN_ATTEMPT),
    ),
  );
  core.info(
    shouldBuild
      ? `Building fork with ${release.tag_name}`
      : "The current fork and upstream nightly are already published.",
  );
}

module.exports = { latestNightly, sourceMarker, nightlyVersion, plan };
