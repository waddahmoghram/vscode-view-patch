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
      (
        set -e
        read -r -s -p 'Open VSX access token: ' OVSX_PAT
        printf '\n'
        export OVSX_PAT
        npx --yes ovsx@1.4.0 create-namespace waddahmoghram
      )
      ```

      Creating a namespace makes you a contributor, not its owner.
      Since View Patch already exists on the Marketplace, Open VSX requires **owner** rights to the matching
      `waddahmoghram` namespace before its version can become available there; contributor access is not enough.
      Claim ownership using the namespace template at
      [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose), linking this public
      repository and the Marketplace publisher.
      Wait for approval before enabling the publishing job.
      See the current [publishing](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions) and
      [namespace](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces) requirements.
      Keep access tokens out of command history; the `ovsx` tool also accepts the `OVSX_PAT` environment variable
      instead of the `-p` argument.
   1. Publish the first Open VSX version with that token: a trusted publisher can be registered only for an
      extension that already has an active version. Save the token as the repository secret `OVSX_PAT` and set
      the repository variable `OPEN_VSX_PUBLISHING` to `token` before a release, or upload an existing release's
      `.vsix` through the Open VSX site's **Publish Extension** action. Only the step that publishes to Open VSX
      receives the secret, not dependency installation or any other step. The Open VSX job is skipped while the
      variable is unset.
   1. Optional, to stop storing a token: once you own the namespace, register this repository's `publish.yml`
      workflow for the `view-patch` extension on the open-vsx.org **Trusted Publishers** settings page, set
      `OPEN_VSX_PUBLISHING` to `trusted`, and delete the `OVSX_PAT` secret and the access token. The job then
      exchanges its GitHub identity for a short-lived token that can publish only this extension.

### Enable the existing Open VSX job

The job is already implemented; changing its workflow condition is not necessary.
After accepting the Publisher Agreement yourself and obtaining namespace ownership:

1. Generate an Open VSX access token for this repository.
   In GitHub **Settings** > **Secrets and variables** > **Actions** > **Secrets**, add the repository secret
   `OVSX_PAT` with that token.
   Do not put the token in a repository variable, a file, an issue, or a chat message.
1. In the **Variables** tab on the same settings page, add the repository variable `OPEN_VSX_PUBLISHING` with
   the exact value `token`.
   The next intentional Publish run will publish its verified package to both registries.
   Adding the variable does not itself run publishing, and leaving it unset keeps the optional job skipped.
1. Check that the Open VSX job succeeds and its package digest matches the Marketplace publishing job.
   Registry scanning can delay availability; check the listing after processing.
   If only Open VSX fails, rerun only that failed job, not the whole Publish workflow.

To add the existing regular 0.3.7 without republishing it to the Marketplace, download `view-patch.vsix` from
[its GitHub release](https://github.com/waddahmoghram/vscode-view-patch/releases/tag/v0.3.7).
Verify its Secure Hash Algorithm, 256-bit (SHA-256) checksum is
`185c6d9881a67dcd65467e5dd5a6003ba6ed3f83d048bc0d1160553101639de4`, then
upload that unchanged package with the Open VSX site's **Publish Extension** action.
Do not rerun this repository's Publish workflow for 0.3.7: the Marketplace version is already published.
Before advertising support for another editor, smoke-test the package in that editor; a registry listing alone
does not prove compatibility.

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
   for all Linux, macOS, Windows, oldest-supported-editor, and web tests, dependency auditing, packaging, and a smoke
   test of that `.vsix` as installed to pass.
   It then checks the tag against `package.json`, downloads that exact `.vsix`, checks its channel, and records its
   SHA-256 digest; the packaging job records the digest too, so the two can be compared. Before publishing, it writes
   the GitHub release notes with [`scripts/release-notes.mjs`](scripts/release-notes.mjs): the version's `## <version>`
   section of `CHANGELOG.md`, with relative links pointed at the tag, then the Marketplace link and the digest. A
   missing or empty section stops the run before anything is published. It publishes that file and attaches the same
   file, with those notes, to a GitHub release. Concurrent publishing runs are serialized. To preview the notes, run
   `node scripts/release-notes.mjs`.
1. When Open VSX publishing is enabled, a separate job checks for the same `CHANGELOG.md` section, then publishes the
   same file there and records its digest. If only that job fails, re-run it alone; re-running the whole workflow
   would try to publish the Marketplace version again, which the Marketplace refuses. To add a version that is
   already on the Marketplace, upload its unchanged `.vsix` through the Open VSX site's **Publish Extension** action.

## Pre-releases

Run the Publish workflow by hand from the **Actions** tab, from `main`, with **Publish as a pre-release** checked.
A pre-release needs a version number of its own.
Preview status is a flag recorded in the package when the verification workflow builds it, not a `-beta` suffix on the version.
VS Code moves users to the highest available version, so plan preview and regular versions together.

For the prepared `0.3.8` candidate, the version and lockfile are already updated and the notes are under `## 0.3.8`.
Do not bump them again unless that version has since been published.
Use this sequence to finish the release:

1. Review the changes from `main` to `vp/usability-0.3.8`.
   In a clean checkout on `main`, run `git merge --ff-only vp/usability-0.3.8`.
   If it cannot fast-forward, stop and reconcile the changes before publishing.
1. From an authenticated terminal, push only `main` to `https://github.com/waddahmoghram/vscode-view-patch.git`.
   Do not create or push `v0.3.8`: version tags trigger a regular release in this repository.
1. On [Actions](https://github.com/waddahmoghram/vscode-view-patch/actions), wait for continuous integration (CI) and CodeQL to pass on the pushed commit.
   Check that the Windows unit tests skip only the one filename test documented in [the test plan](TEST_PLAN.md#test-inventory).
1. Open [Publish](https://github.com/waddahmoghram/vscode-view-patch/actions/workflows/publish.yml), choose **Run workflow**, select `main`, leave **Publish as a pre-release** checked, and run it once.
   Confirm the run uses the intended commit.
   Trusted Publishing uses the workflow's identity, so no local Marketplace token is needed.
1. Wait for every verification job and the Marketplace publish job to pass.
   The optional Open VSX job may be skipped.
   The package and publishing summaries must show `pre-release` and the same SHA-256 checksum.
1. After Marketplace processing, check [View Patch](https://marketplace.visualstudio.com/items?itemName=waddahmoghram.view-patch) offers `0.3.8` as a pre-release while `0.3.7` remains the regular version.
   Choose **Switch to Pre-Release Version** in VS Code, reload, and run **View Patch: Show Environment** or
   **View Patch: Copy Diagnostics** to confirm `0.3.8` is actually loaded.

This manual workflow does not create a GitHub release.
If a run fails after publishing has started, inspect its publishing step and the Marketplace before retrying; never blindly rerun an already-published version.
If source changes are needed after publication, use a new version.

Before promoting this candidate to a regular release, repeat [manual check A](RELEASE_RUNBOOK.md#6-manual-check-a-a-real-remote-window) in a real remote window and [manual check B](RELEASE_RUNBOOK.md#7-manual-check-b-public-vscodedev) on public vscode.dev, using `0.3.8` for the runtime identity gate rather than the old campaign's version.
Also check the version and host in the Patch Reviews title in local, remote, and browser windows, that the empty
view still shows its welcome buttons, and open the log with **Show View Patch Output**.
With a different patch active, right-click the intended review and switch it to hunks only and back to complete
files; it should reuse that review, keep its target and reviewed marks, and leave the other review untouched.
In the browser, the review menu must not offer complete files.
Use a screen reader to confirm that file labels say "reviewed" or "not reviewed" as the mark changes, and
"partial context"; automated label checks do not prove actual speech output.
Automated tests do not replace these manual checks.

## Checking a package locally

```bash
npm ci
npm audit --include=dev
npm test
npx vsce package --out view-patch.vsix
npx vsce ls
npm run test:package
```

On Linux without a display, run the tests as `xvfb-run -a npm test` and `xvfb-run -a npm run test:package`. Tests
include real trusted-editor sessions and an isolated editor launched in Restricted Mode without the usual test
runner's trust bypass.
Set `VSCODE_TEST_VERSION=1.90.0` to repeat integration tests on the oldest supported editor.
`npx vsce ls` lists the files that go into the package.
`npm run test:package` is the check CI's `smoke` job runs on the package it built: it installs `view-patch.vsix`
(or the path given after `--`) into a fresh extensions folder, checks that the installed copy activates at the
package's version rather than this checkout, opens the sample, a complete-file review in a temporary repository
that must stay unchanged, and a hunk-only review. It runs the compiled suite from `out/`, so `npm test` or
`npm run compile` must come first. It is a desktop, local-window check only.

The overrides in [`package.json`](./package.json) keep transitive development-tool dependencies on patched releases
while their parent tools still request vulnerable versions. Keep [`package-lock.json`](./package-lock.json) in sync.
Before removing an override, confirm the normal dependency tree is no longer vulnerable and repeat these checks,
including the oldest supported editor.

Before a regular public release, also try a complete-file review, a hunk-only review, refresh, and closing the last
tab in an actual remote window, and a hunk-only review on vscode.dev for the web build. The
[regular release runbook](RELEASE_RUNBOOK.md) gives the exact steps, expected results, and record. Provider-backed
address tests cover path handling but are not an end-to-end remote connection or web-session test, and the
installed-package smoke test uses a local window, not a remote extension host or vscode.dev.

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
  Dependabot pull requests. A run that skipped the Open VSX job, as it does while `OPEN_VSX_PUBLISHING` is unset,
  shows that job as skipped and compares the others. The package and Marketplace publish jobs, and an Open VSX job
  that ran, must each succeed and print a digest; otherwise the digest rule cannot be evaluated, unless the digests
  already disagree.
- Freshness: when the page was generated and how old the latest CI, CodeQL, and Publish runs, the Marketplace
  version, and the previous metrics snapshot were then. The page does not update itself; one generated more than
  two days ago means the workflow has stopped.
- The change in each aggregate number since the previous metrics snapshot: pass rates, re-runs, the median CI
  duration, test counts, registry installs, downloads, and updates, and open Dependabot pull requests. A value that
  either snapshot could not read is shown as unavailable with its reason, never as 0, and has no change.

Every run adds a summary to its own run page and keeps the site for a day as its `github-pages` artifact. It also
writes `metrics-YYYY-MM-DD.json`, named for the run's UTC day, with only those aggregate numbers, the readiness
verdict, the Marketplace version, and a reason for each value it could not read, and keeps it for 90 days as its
`dashboard-metrics` artifact, so no daily statistics are committed to the repository. Before building, the
workflow downloads the newest unexpired `dashboard-metrics` artifact from an earlier UTC day with the job's own
token, three or four requests outside the script's budget, and the page compares with it. When that step finds or
downloads nothing, the page says there is no previous snapshot. To publish the site with GitHub Pages:

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

To compare with earlier snapshots locally, download them into one folder and pass it with `--history-dir` (or
`DASHBOARD_HISTORY_DIR`). The script reads `metrics-YYYY-MM-DD.json` files in that folder and its subfolders,
makes no requests for them, skips and lists any file it cannot use, and compares with the newest one from an
earlier UTC day. For example, with the GitHub command-line tool (`gh`), where `<run-id>` is an earlier Quality
dashboard run:

```bash
gh run download <run-id> --name dashboard-metrics --dir .dashboard-history/<run-id>
node scripts/quality-dashboard.mjs --history-dir .dashboard-history
```
