# Noah's Apple Silicon builds

Keep customizations on `rossnoah/t3code`'s `main` branch. The **Noah's Apple
Silicon Nightly** workflow builds after each push and checks hourly for a new
published upstream nightly. Successful updates advance `main` and publish a
signed, notarized arm64 desktop build. Conflicts or failed checks leave the
previous release available.

## Patch stack

`main` contains the complete source and keeps its existing history. The
`fork/stack` branch contains one linear series of fork commits above an exact
upstream commit. `.fork/stack.json` records that upstream commit, its nightly tag,
and the stack tip. Each integration commit retains the stack as a parent, so old
stacks remain reachable even after `fork/stack` is rebased.

Work normally on feature branches and merge them into `main`. A squash or
non-fast-forward merge gives the updater one logical patch for that feature;
fast-forwarded commits are imported individually. New commits are never silently
ignored. To see the last recorded stack:

```bash
node .github/scripts/fork-stack.cjs list
```

The release job imports changes since the last recorded stack, rebases its
patches onto the latest published upstream nightly, and checks and packages that
exact candidate. Only after tests, signing, and notarization pass does it update
`main` and `fork/stack` together. Concurrent edits to either branch reject that
promotion; the next run retries from the new state. The update uses the workflow's
normal GitHub token, so its own push does not trigger another release run.

Release tags point to the integrated source commit. Both the automatic source
archives and `fork-source.tar.gz` contain the build source before release version
stamping. The release notes record the source commit and patch stack. For a manual
rebuild, run the workflow from Actions with **force** enabled.

## Updating or repairing patches locally

Start from a clean, current `main` checkout. Fetch the desired published upstream
nightly and prepare it in a new worktree outside the checkout:

```bash
git fetch https://github.com/pingdotgg/t3code.git refs/tags/<nightly-tag>
node .github/scripts/fork-stack.cjs prepare <upstream-sha> <nightly-tag> ../t3-fork-update
```

This never changes your starting branch. If a patch conflicts, the command leaves
the rebase in that new worktree. Resolve the conflict there, stage the resolution,
and run `git rebase --continue`. When the rebase completes, run
`node .github/scripts/fork-stack.cjs finish` there to record the new base and stack.
If a patch no longer adds anything because upstream absorbed it, Git drops it.
Review behavior even when the rebase applies cleanly.

To consolidate fixes, change a patch, or retire a feature without changing the
upstream base:

```bash
node .github/scripts/fork-stack.cjs edit ../t3-fork-edit
cd ../t3-fork-edit
git rebase -i <base-from-stack-json>
# Edit, squash, or drop the relevant commits, then complete the rebase.
node .github/scripts/fork-stack.cjs finish
```

Record the resulting commit SHA, run checks relevant to the changed features,
and fast-forward your original branch to it with `git merge --ff-only <sha>`.
Push `main` normally; the release job publishes the updated `fork/stack` after
validation. If `main` moved during the repair, start again from its latest state.
Do not merge upstream directly into `main`, or use the rebased `fork/stack` as a
long-lived development branch. Remove the temporary worktree with
`git worktree remove <path>` after keeping its result on your branch.

## Installing

Install the DMG from this fork's releases. The app's nightly update feed points
to `rossnoah/t3code`, and its bundle ID is `com.rossnoah.t3code`. Push builds produce
an update ZIP; scheduled and manual builds also produce a DMG. Builds support
local, direct, and Tailscale connections; T3 Connect is not configured. These
releases contain the desktop app and its bundled server, not separate CLI or
mobile releases.

## Signing secrets

Repository Actions secrets:

- `CSC_LINK`: base64-encoded personal Developer ID Application certificate and
  private key, exported together as a password-protected PKCS#12 file.
- `CSC_KEY_PASSWORD`: that export's password.
- `APPLE_API_KEY`: the App Store Connect Team API key's `.p8` contents.
- `APPLE_API_KEY_ID`: the key's ID.
- `APPLE_API_ISSUER`: the team's Issuer ID.

Replace these secrets when rotating credentials. Do not commit credential files.
The workflow uses GitHub-hosted Apple Silicon runners and the repository's
automatic token for publishing; it does not need credentials from local Xcode.
