const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { git, integrate, readManifest, prepare, finish, publish } = require("./fork-stack.cjs");

const oldTag = "v0.0.43-nightly.20260917.1";
const newTag = "v0.0.43-nightly.20260917.2";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "t3-fork-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Fork test"]);
  git(repo, ["config", "user.email", "fork@example.test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  function commit(file, content, message, cwd = repo) {
    writeFileSync(path.join(cwd, file), content);
    git(cwd, ["add", file]);
    git(cwd, ["commit", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
  }
  const base = commit("shared.txt", "upstream\n", "upstream base");
  const tip = commit("custom.txt", "customization\n", "feat: custom feature");
  const source = integrate(repo, tip, base, tip, oldTag);
  git(repo, ["reset", "--hard", source]);
  git(repo, ["branch", "fork/stack", tip]);
  function upstream(content = "new upstream\n", file = "upstream.txt") {
    git(repo, ["checkout", "--detach", base]);
    const next = commit(file, content, "upstream update");
    git(repo, ["checkout", "main"]);
    return next;
  }
  return {
    root,
    repo,
    base,
    tip,
    source,
    commit,
    upstream,
    candidate: path.join(root, "candidate"),
  };
}

test("replays patches, imports new main commits, and records an exact fast-forwardable source", (t) => {
  const f = fixture(t);
  f.commit("custom.txt", "customization\nfollow-up\n", "fix: refine feature");
  f.commit("second.txt", "another feature\n", "feat: second feature");
  const source = git(f.repo, ["rev-parse", "HEAD"]);
  const base = f.upstream();
  const candidate = prepare(f.repo, base, newTag, f.candidate);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), source);
  const manifest = readManifest(f.candidate);
  assert.equal(manifest.base, base);
  assert.equal(manifest.tag, newTag);
  assert.equal(git(f.repo, ["rev-parse", `${candidate}^1`]), source);
  assert.equal(git(f.repo, ["rev-parse", `${candidate}^2`]), manifest.tip);
  assert.deepEqual(
    git(f.repo, ["log", "--reverse", "--format=%s", `${base}..${manifest.tip}`]).split("\n"),
    ["feat: custom feature", "fix: refine feature", "feat: second feature"],
  );
  assert.equal(
    readFileSync(path.join(f.candidate, "custom.txt"), "utf8"),
    "customization\nfollow-up\n",
  );
  assert.equal(readFileSync(path.join(f.candidate, "upstream.txt"), "utf8"), "new upstream\n");
  assert.equal(git(f.repo, ["diff", "--name-only", manifest.tip, candidate]), ".fork/stack.json");
});

test("unchanged upstream and patches reuse the source commit", (t) => {
  const f = fixture(t);
  assert.equal(prepare(f.repo, f.base, oldTag, f.candidate), f.source);
});

test("a second update imports only changes made since the previous integration", (t) => {
  const f = fixture(t);
  const base = f.upstream();
  const first = prepare(f.repo, base, newTag, f.candidate);
  git(f.repo, ["merge", "--ff-only", first]);
  f.commit("custom.txt", "updated feature\n", "fix: improve feature");
  const next = path.join(f.root, "next");
  prepare(f.repo, base, newTag, next);
  const { tip } = readManifest(next);
  assert.equal(git(f.repo, ["rev-list", "--count", `${base}..${tip}`]), "2");
  assert.equal(readFileSync(path.join(next, "custom.txt"), "utf8"), "updated feature\n");
});

test("editing the stack can retire a feature while retaining main history", (t) => {
  const f = fixture(t);
  prepare(f.repo, f.base, oldTag, f.candidate, { edit: true });
  // Equivalent to dropping the only feature during an interactive rebase.
  git(f.candidate, ["reset", "--hard", f.base]);
  const candidate = finish(f.candidate);
  assert.equal(readManifest(f.candidate).tip, f.base);
  assert.equal(git(f.repo, ["rev-parse", `${candidate}^1`]), f.source);
  assert.equal(git(f.candidate, ["ls-files", "custom.txt"]), "");
});

test("conflicts preserve main and can be resolved and finished in the candidate", (t) => {
  const f = fixture(t);
  f.commit("shared.txt", "fork change\n", "feat: overlapping customization");
  const source = git(f.repo, ["rev-parse", "HEAD"]);
  const base = f.upstream("upstream change\n", "shared.txt");
  assert.throws(() => prepare(f.repo, base, newTag, f.candidate), /Patch conflict/);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), source);
  assert.equal(git(f.repo, ["rev-parse", "fork/stack"]), f.tip);
  assert.throws(() => finish(f.candidate), /Commit or stash|Complete the rebase/);
  writeFileSync(path.join(f.candidate, "shared.txt"), "combined change\n");
  git(f.candidate, ["add", "shared.txt"]);
  assert.throws(() => finish(f.candidate), /Commit or stash|Complete the rebase/);
  git(f.candidate, ["-c", "core.editor=true", "rebase", "--continue"]);
  const result = finish(f.candidate);
  assert.equal(git(f.repo, ["rev-parse", `${result}^1`]), source);
  assert.equal(readManifest(f.candidate).base, base);
  assert.equal(readFileSync(path.join(f.candidate, "shared.txt"), "utf8"), "combined change\n");
});

test("upstream absorbing a patch drops it while preserving the other features", (t) => {
  const f = fixture(t);
  const base = f.upstream("customization\n", "custom.txt");
  prepare(f.repo, base, newTag, f.candidate);
  assert.equal(readManifest(f.candidate).tip, base);
});

test("imports merge commits as one logical feature without replaying merged branch history", (t) => {
  const f = fixture(t);
  git(f.repo, ["checkout", "-b", "feature"]);
  f.commit("new-feature.txt", "feature\n", "initial implementation");
  f.commit("new-feature.txt", "finished feature\n", "refine implementation");
  git(f.repo, ["checkout", "main"]);
  git(f.repo, ["merge", "--no-ff", "feature", "-m", "feat: finished feature"]);
  prepare(f.repo, f.base, oldTag, f.candidate);
  const { tip } = readManifest(f.candidate);
  assert.equal(git(f.repo, ["rev-list", "--count", `${f.base}..${tip}`]), "2");
  assert.equal(git(f.repo, ["log", "-1", "--format=%s", tip]), "feat: finished feature");
});

test("rejects dirty worktrees and upstream downgrades before creating a candidate", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.repo, "custom.txt"), "uncommitted\n");
  assert.throws(() => prepare(f.repo, f.base, oldTag, f.candidate), /Commit or stash/);
  git(f.repo, ["restore", "custom.txt"]);
  const base = f.upstream();
  prepare(f.repo, base, newTag, f.candidate);
  assert.throws(() => prepare(f.candidate, f.base, oldTag, path.join(f.root, "downgrade")));
});

for (const concurrent of [null, "main", "fork/stack"]) {
  test(`atomic publishing ${concurrent ? `rejects concurrent ${concurrent} changes` : "advances both refs"}`, (t) => {
    const f = fixture(t);
    const remote = path.join(f.root, "remote.git");
    git(f.repo, ["init", "--bare", remote]);
    git(f.repo, ["remote", "add", "origin", remote]);
    git(f.repo, ["push", "origin", "main", "fork/stack"]);
    const base = f.upstream();
    const candidate = prepare(f.repo, base, newTag, f.candidate);
    if (concurrent) {
      const tree = git(f.repo, ["rev-parse", `${f.source}^{tree}`]);
      const other = git(f.repo, ["commit-tree", tree, "-p", f.source], {
        input: "concurrent edit\n",
      });
      git(f.repo, ["push", "origin", `${other}:refs/heads/${concurrent}`]);
      const before = git(f.repo, ["ls-remote", "origin", "refs/heads/*"]);
      assert.throws(() => publish(f.candidate, f.source, f.tip));
      assert.equal(git(f.repo, ["ls-remote", "origin", "refs/heads/*"]), before);
    } else {
      publish(f.candidate, f.source, f.tip);
      assert.equal(
        git(f.repo, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0],
        candidate,
      );
      assert.equal(
        git(f.repo, ["ls-remote", "origin", "refs/heads/fork/stack"]).split("\t")[0],
        readManifest(f.candidate).tip,
      );
    }
  });
}
