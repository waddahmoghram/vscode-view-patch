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
   cannot be changed later. Only the identifier and name are required. Leave any website or **Verified domain** field
   empty unless you own an eligible domain; the optional verified badge also needs six months of Marketplace history.
1. On that publisher, open **Trusted Publishing** and create a policy, so the Publish workflow can sign in without a
   stored token:

   | Field            | Value               |
   | ---------------- | ------------------- |
   | Policy name      | `Release workflow`  |
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

      Creating a namespace makes you a contributor, not its owner, so Open VSX shows published versions as
      unverified. To have them shown as verified, claim ownership by opening an issue at
      [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose).
   1. Publish the first Open VSX version with that token: a trusted publisher can be registered only for an
      extension that already has an active version. Save the token as the repository secret `OVSX_PAT` and set
      the repository variable `OPEN_VSX_PUBLISHING` to `token` before a release, or publish an existing release's
      `.vsix` by hand with `npx ovsx publish view-patch.vsix -p <token>`. Only the step that publishes to Open VSX
      receives the secret, not dependency installation or any other step. The Open VSX job is skipped while the
      variable is unset.
   1. Optional, to stop storing a token: once you own the namespace, register this repository's `publish.yml`
      workflow for the `view-patch` extension on the open-vsx.org **Trusted Publishers** settings page, set
      `OPEN_VSX_PUBLISHING` to `trusted`, and delete the `OVSX_PAT` secret and the access token. The job then
      exchanges its GitHub identity for a short-lived token that can publish only this extension.

## Release channels

The preview phase ended with the first regular release: 0.2.0 was published as a pre-release, 0.3.0 as a regular
release, 0.3.1 through 0.3.4 as pre-releases, and 0.3.5 as a regular release. 0.3.2 was the first release published
from the package continuous integration verified, and 0.3.5 the first published by pushing a version tag, after the
[regular release runbook](RELEASE_RUNBOOK.md)'s manual checks. Each version number can be published only once, on one
channel.

To publish a pre-release:

1. Set the next `version` in `package.json` and add a section for it to `CHANGELOG.md`, folding in any `Unreleased`
   entries.
1. Commit and push to `main`, without a tag.
1. Run the Publish workflow by hand, as described under [Pre-releases](#pre-releases).

For a regular release, follow [Each release](#each-release) together with the
[regular release runbook](RELEASE_RUNBOOK.md), which adds the manual checks, the decision rules, and the exit
verification. Running the Publish workflow by hand with **Publish as a pre-release** cleared also publishes a
regular release, but without a tag or a GitHub release. VS Code moves users to the highest available version, so
give a regular release a version higher than the latest pre-release for pre-release users to move to it too.

## Each release

1. Set `version` in `package.json` and add a section for it to `CHANGELOG.md`, folding in any `Unreleased` entries.
   The Marketplace accepts only `major.minor.patch` versions.
1. Commit, tag, and push. For example, for version 1.0.0:

   ```bash
   git tag v1.0.0
   git push origin main v1.0.0
   ```

1. The Publish workflow first calls the shared verification workflow, which builds the `.vsix` once. Publishing waits
   for all Linux, macOS, Windows, oldest-supported-editor, and web tests, dependency auditing, and packaging to pass.
   It then checks the tag against `package.json`, downloads that exact `.vsix`, checks its channel, and records its
   SHA-256 digest; the packaging job records the digest too, so the two can be compared. It publishes that file and
   attaches the same file to a GitHub release. Concurrent publishing runs are serialized.
1. When Open VSX publishing is enabled, a separate job publishes the same file there and records its digest. If only
   that job fails, re-run it alone; re-running the whole workflow would try to publish the Marketplace version
   again, which the Marketplace refuses. To add a version that is already on the Marketplace, publish its `.vsix`
   by hand with `npx ovsx publish view-patch.vsix -p <token>`.

## Pre-releases

Run the Publish workflow by hand from the **Actions** tab, from `main`, with **Publish as a pre-release** checked. A
pre-release needs a version number of its own. Preview status is a flag recorded in the package when the verification
workflow builds it, not a `-beta` suffix on the version. VS Code moves users to the highest available version, so plan
preview and regular versions together.

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
tab in an actual remote window, and a hunk-only review on vscode.dev for the web build. The
[regular release runbook](RELEASE_RUNBOOK.md) gives the exact steps, expected results, and record. Provider-backed
address tests cover path handling but are not an end-to-end remote connection or web-session test.

## Quality dashboard

The Quality dashboard workflow ([`dashboard.yml`](.github/workflows/dashboard.yml)) runs
[`scripts/quality-dashboard.mjs`](scripts/quality-dashboard.mjs) daily, when started by hand, and after each
continuous integration (CI) or Publish run on `main` or a release tag finishes. Its page shows:

- A release-readiness verdict with each rule's result and evidence: the latest CI run on `main` succeeded, the
  latest CodeQL run there did not fail, the latest successful Publish run recorded matching package digests or none
  to compare, and no Dependabot pull request has been open longer than 14 days. A failed rule means not ready; a
  rule that cannot be evaluated, such as the digest rule without job logs, leaves the verdict undetermined.
- CI, CodeQL, and Publish history: pass rates, re-runs as a sign of flaky tests, durations, the latest CI run's
  jobs, and the test counts that its logs report.
- The digests that Publish run recorded, next to the Marketplace's own digest of the version it published; the
  Marketplace's latest version, channel, and install, download, and update counts; the Open VSX listing; and open
  Dependabot pull requests.

Every run adds a summary to its own run page and keeps the site for a day as its `github-pages` artifact. To
publish the site with GitHub Pages:

1. In the repository's **Settings** > **Pages**, set **Source** to **GitHub Actions**.
1. In **Settings** > **Secrets and variables** > **Actions** > **Variables**, add the repository variable
   `DASHBOARD_PAGES` with the value `true`.

The deploy job is skipped until then. Once it runs, the site's address appears on that job and under
**Settings** > **Pages**.

To build the dashboard locally, from the repository root:

```bash
node scripts/quality-dashboard.mjs
```

Open `.dashboard/index.html`; `.dashboard/data.json` holds the same data. Without `GITHUB_TOKEN`, the script makes
six GitHub requests, well under the limit of 60 an hour for unauthenticated use, and shows the values that only
job logs hold, the test counts and digests, as unavailable. Set `GITHUB_TOKEN` to a token that can read this
repository's Actions to include them, and `DASHBOARD_OUT` to write somewhere else.
