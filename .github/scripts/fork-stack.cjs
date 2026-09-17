const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const manifestPath = ".fork/stack.json";
const sourcePaths = [".", `:(exclude)${manifestPath}`];

function git(cwd, args, options = {}) {
  const { raw = false, ...execOptions } = options;
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...execOptions,
  });
  return raw ? output : output.trim();
}

function clean(cwd) {
  if (git(cwd, ["status", "--porcelain"])) {
    throw new Error("Commit or stash changes before working on the fork stack.");
  }
}

function linearStack(cwd, base, tip) {
  git(cwd, ["merge-base", "--is-ancestor", base, tip]);
  if (git(cwd, ["rev-list", "--merges", `${base}..${tip}`])) {
    throw new Error("The patch stack must be linear. Rebase it instead of merging upstream.");
  }
}

function readManifest(cwd, ref = "HEAD") {
  const manifest = JSON.parse(git(cwd, ["show", `${ref}:${manifestPath}`]));
  if (
    manifest.version !== 1 ||
    ![manifest.base, manifest.tip].every((sha) => /^[0-9a-f]{40}$/.test(sha)) ||
    !/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(manifest.tag)
  ) {
    throw new Error("Invalid fork stack manifest.");
  }
  linearStack(cwd, manifest.base, manifest.tip);
  git(cwd, ["merge-base", "--is-ancestor", manifest.tip, ref]);
  return manifest;
}

// Keep main fast-forwardable while retaining the rebased commits as a second
// parent. Only this small manifest differs from the patch stack's source tree.
function integrate(cwd, source, base, tip, tag) {
  linearStack(cwd, base, tip);
  if (!/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)) {
    throw new Error("Expected an upstream nightly tag.");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "t3-fork-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
    git(cwd, ["read-tree", tip], { env });
    const blob = git(cwd, ["hash-object", "-w", "--stdin"], {
      input: `${JSON.stringify({ version: 1, base, tip, tag }, null, 2)}\n`,
    });
    git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${manifestPath}`], { env });
    const tree = git(cwd, ["write-tree"], { env });
    const parents = [...new Set([source, tip])].flatMap((parent) => ["-p", parent]);
    return git(cwd, ["commit-tree", tree, ...parents], {
      input: `chore(fork): record patch stack on ${tag}\n`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function contextPath(cwd) {
  return git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "fork-stack-update.json"]);
}

function finish(cwd) {
  clean(cwd);
  const { source, base, tag } = JSON.parse(readFileSync(contextPath(cwd), "utf8"));
  // A conflict must be resolved with rebase --continue before promotion.
  for (const state of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "MERGE_HEAD"]) {
    if (existsSync(path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", state])))) {
      throw new Error("Complete the rebase before finishing the stack update.");
    }
  }
  const tip = git(cwd, ["rev-parse", "HEAD"]);
  const previous = readManifest(cwd, source);
  const commit =
    previous.base === base && previous.tip === tip && previous.tag === tag
      ? source
      : integrate(cwd, source, base, tip, tag);
  git(cwd, ["checkout", "--detach", commit]);
  rmSync(contextPath(cwd));
  return commit;
}

function prepare(cwd, upstream, tag, destination, { edit = false } = {}) {
  clean(cwd);
  const source = git(cwd, ["rev-parse", "HEAD"]);
  const manifest = readManifest(cwd);
  const base = git(cwd, ["rev-parse", "--verify", `${upstream}^{commit}`]);
  if (!/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)) {
    throw new Error("Expected an upstream nightly tag.");
  }
  // Never silently downgrade to an older or unrelated upstream history.
  git(cwd, ["merge-base", "--is-ancestor", manifest.base, base]);
  const checkpoint = git(cwd, ["log", "-1", "--first-parent", "--format=%H", "--", manifestPath]);
  const worktree = path.resolve(destination);
  git(cwd, ["worktree", "add", "--detach", worktree, manifest.tip]);

  // Import ordinary main commits, including squash/merge commits, as their
  // first-parent changes. Existing feature commits remain individually editable.
  const commits = git(cwd, ["rev-list", "--first-parent", "--reverse", `${checkpoint}..${source}`]);
  for (const commit of commits.split("\n").filter(Boolean)) {
    const patch = git(cwd, ["diff", "--binary", `${commit}^1`, commit, "--", ...sourcePaths], {
      raw: true,
    });
    if (!patch) continue;
    git(worktree, ["apply", "--index", "--3way"], { input: patch });
    git(worktree, ["commit", "-C", commit]);
  }
  // Catch missing commits or a manually edited manifest before trying upstream.
  git(worktree, ["diff", "--exit-code", source, "HEAD", "--", ...sourcePaths]);
  writeFileSync(contextPath(worktree), `${JSON.stringify({ source, base, tag })}\n`);
  if (edit) return worktree;
  try {
    git(worktree, [
      "-c",
      "core.hooksPath=/dev/null",
      "rebase",
      "--reapply-cherry-picks",
      "--empty=drop",
      "--onto",
      base,
      manifest.base,
    ]);
  } catch (cause) {
    throw new Error(
      `Patch conflict in ${worktree}. Resolve it, run git rebase --continue, then run ` +
        `node ${path.join(cwd, ".github/scripts/fork-stack.cjs")} finish from that worktree. ` +
        "Main and the published stack have not changed.",
      { cause },
    );
  }
  return finish(worktree);
}

function publish(cwd, source, expectedStack, remote = "origin") {
  const candidate = git(cwd, ["rev-parse", "HEAD"]);
  const { tip } = readManifest(cwd);
  if (!/^[0-9a-f]{40}$/.test(source) || (expectedStack && !/^[0-9a-f]{40}$/.test(expectedStack))) {
    throw new Error("Expected full source and stack SHAs.");
  }
  git(cwd, ["merge-base", "--is-ancestor", source, candidate]);
  // Both refs move together, and only if neither has changed since preparation.
  // The ancestry check above prevents rewriting main despite the explicit lease.
  return git(cwd, [
    "push",
    "--atomic",
    `--force-with-lease=refs/heads/main:${source}`,
    `--force-with-lease=refs/heads/fork/stack:${expectedStack}`,
    remote,
    `${candidate}:refs/heads/main`,
    `${tip}:refs/heads/fork/stack`,
  ]);
}

if (require.main === module) {
  try {
    const [command, upstream, tag, destination] = process.argv.slice(2);
    if (command === "prepare" && upstream && tag && destination) {
      console.log(prepare(process.cwd(), upstream, tag, destination));
    } else if (command === "finish" && !upstream) {
      console.log(finish(process.cwd()));
    } else if (command === "edit" && upstream && !tag) {
      const manifest = readManifest(process.cwd());
      console.log(prepare(process.cwd(), manifest.base, manifest.tag, upstream, { edit: true }));
      console.log(
        `Edit patches with git rebase -i ${manifest.base}, then run fork-stack.cjs finish.`,
      );
    } else if (command === "list" && !upstream) {
      const { base, tip, tag: nightly } = readManifest(process.cwd());
      console.log(`Upstream: ${nightly} (${base})`);
      console.log(git(process.cwd(), ["log", "--reverse", "--oneline", `${base}..${tip}`]));
    } else if (command === "publish" && upstream && tag && !destination) {
      console.log(publish(process.cwd(), upstream, tag === "-" ? "" : tag));
    } else {
      throw new Error(
        "Usage: fork-stack.cjs list | prepare <upstream-sha> <nightly-tag> <new-worktree> | edit <new-worktree> | finish | publish <source-sha> <previous-stack-sha-or-dash>",
      );
    }
  } catch (error) {
    console.error(error.message);
    if (error.cause?.stderr) console.error(error.cause.stderr.toString());
    process.exitCode = 1;
  }
}

module.exports = { git, integrate, readManifest, prepare, finish, publish };
