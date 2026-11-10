# Releasing View Patch

How to publish View Patch to the Visual Studio Code (VS Code) Marketplace, and optionally to Open VSX, the registry
that VS Code-compatible editors such as VSCodium use.

## One-time setup

1. Create an empty public repository named `vscode-view-patch` under the `waddahmoghram` GitHub account, then push:

   ```bash
   git remote add origin https://github.com/waddahmoghram/vscode-view-patch.git
   git push -u origin main
   ```

1. Sign in to the [Marketplace publisher page](https://marketplace.visualstudio.com/manage) with a Microsoft account and
   create a publisher whose identifier is `waddahmoghram`, the `publisher` value in `package.json`. The identifier
   cannot be changed later.
1. On that publisher, open **Trusted Publishing** and create a policy, so the Publish workflow can sign in without a
   stored token:

   | Field            | Value               |
   | ---------------- | ------------------- |
   | Repository owner | `waddahmoghram`     |
   | Repository       | `vscode-view-patch` |
   | Workflow         | `publish.yml`       |
   | Environment      | leave empty         |

1. Optional, for Open VSX:
   1. Create an [eclipse.org account](https://accounts.eclipse.org/user/register) with your GitHub user name filled in.
   1. Sign in to [open-vsx.org](https://open-vsx.org) with GitHub, link the Eclipse account, and sign the Publisher
      Agreement from your profile page.
   1. Create an access token on the open-vsx.org **Access Tokens** page, then create the namespace once:

      ```bash
      npx ovsx create-namespace waddahmoghram -p <token>
      ```

   1. Save the token as the repository secret `OVSX_PAT`. The Publish workflow skips Open VSX when it is not set.

## First public release

The prepared version is 0.2.0. Nothing is published by building or installing it locally.

1. Run the Publish workflow by hand, as described under [Pre-releases](#pre-releases), for the first public preview.
1. Install it from the Marketplace with **Switch to Pre-Release Version** on the extension page in VS Code, and try it.
1. Use a new version, such as 0.2.1, for a later regular release. A preview and a regular release cannot reuse the same
   version number.

## Each release

1. Set `version` in `package.json` and add a section for it to `CHANGELOG.md`. The Marketplace accepts only
   `major.minor.patch` versions.
1. Commit, tag, and push. For version 0.2.0:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

1. The Publish workflow first calls the shared verification workflow. Publishing waits for all Linux, macOS, Windows,
   and oldest-supported-editor tests, dependency auditing, and packaging to pass. It then checks the tag against
   `package.json`, publishes, and creates a GitHub release with the `.vsix` file attached. Concurrent publishing runs
   are serialized.

## Pre-releases

Run the Publish workflow by hand from the **Actions** tab, from `main`, with **Publish as a pre-release** checked. A
pre-release needs a version number of its own. Preview status is a publishing flag, not a `-beta` suffix on the
version. VS Code moves users to the highest available version, so plan preview and regular versions together.

## Checking a package locally

```bash
npm ci
npm audit --include=dev
npm test
npx vsce package
npx vsce ls
```

On Linux without a display, run the tests as `xvfb-run -a npm test`. Tests include real trusted-editor sessions and
an isolated editor launched in Restricted Mode without the usual test runner's trust bypass.
Set `VSCODE_TEST_VERSION=1.90.0` to repeat integration tests on the oldest supported editor.
`npx vsce ls` lists the files that go into the package.

The overrides in [`package.json`](./package.json) keep transitive development-tool dependencies on patched releases
while their parent tools still request vulnerable versions. Keep [`package-lock.json`](./package-lock.json) in sync.
Before removing an override, confirm the normal dependency tree is no longer vulnerable and repeat these checks,
including the oldest supported editor.

Before a regular public release, also try a complete-file review, a hunk-only review, refresh, and closing the last
tab in an actual remote window. Provider-backed address tests cover path handling but are not an end-to-end remote
connection test.
