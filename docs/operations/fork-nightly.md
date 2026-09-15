# Noah's Apple Silicon builds

Keep customizations on `rossnoah/t3code`'s `main` branch. The **Noah's Apple
Silicon Nightly** GitHub Actions workflow builds after each push and checks hourly
for a new published upstream nightly. All fork commits are included, including
future changes beyond the branch-prefix setting.

Each build merges the latest upstream nightly into the fork in an isolated
runner, runs focused checks, and signs and notarizes an arm64 desktop build.
It leaves `main` unchanged. The release's `fork-source.tar.gz` contains the merged
source; GitHub's automatic source archives contain only the fork commit.

If upstream changes conflict with your customizations, the workflow fails before
publishing. Merge that upstream nightly tag into your fork locally, resolve the
conflicts, and push the result to `main`. The previous release remains available.
For a manual rebuild, run the workflow from Actions with **force** enabled.

Install the DMG from this fork's releases. The app's nightly update feed points
to `rossnoah/t3code`, and its bundle ID is `com.rossnoah.t3code`. Builds support
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
