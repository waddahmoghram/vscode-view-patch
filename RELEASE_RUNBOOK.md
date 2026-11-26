# Regular release runbook

Created 2026-11-11. Use it for every regular (non-pre-release) release. [RELEASING.md](RELEASING.md) is the
general procedure and one-time setup; [TEST_PLAN.md](TEST_PLAN.md) names the automated gates. This runbook adds
the manual checks a regular release needs, the tag-driven publish, and the exit verification, with the decision
rules for each step.

> **Status:** COMPLETE for regular 0.3.9, published 2026-11-26 by pushing tag `v0.3.9`. Both checks passed on
> pre-release 0.3.8 that day: check B with steps 6 and 7 as written in a signed-in session, and check A in a
> real Remote - SSH window, with its steps 3 and 4 run again in a substitute on the same host (section 12). The
> exit verification of 0.3.9 passed. Before the release, the history was rewritten to remove co-author trailers:
> every commit hash changed, and no shipped file did (section 13).
>
> **Current verdict:** PASS.
>
> **Controlling corrections:** [2026-11-26 release checks automated](#2026-11-26---release-checks-automated): a
> step that an automated run reports as PASS counts as run as written; sections 6 and 7 say which of its
> substitutes count. [2026-11-26 history rewrite](#2026-11-26---history-rewritten): a rewrite that keeps
> every shipped file keeps a campaign's identities, with section 3 naming both commits.
> [2026-11-24 0.3.7 campaign](#2026-11-24---037-campaign): the release commit is made on the tested source commit
> and tagged there, because `main` moved past that commit.
> [2026-11-11 review correction](#2026-11-11---review-correction): the release target moved from 0.3.4 to 0.3.5.
> [Check B step 5 correction](#2026-11-11---check-b-step-5-correction): a file-backed patch now tests saving on
> the web.

## 1. Purpose

A regular release is what every user gets from **Install**, so it needs evidence the automated suites cannot
provide: the extension working in a real remote window and on public vscode.dev, installed from the Marketplace.
The question each campaign answers: is the candidate commit safe to publish on the regular channel?

## 2. Validation contract

### Preconditions

- The candidate's code was already published as a pre-release, its Publish run passed, and its packaging,
  publishing, and Marketplace digests matched.
- Continuous integration (CI) and CodeQL are green on `main` at the commit that pre-release came from.
- The release commit will change only the version, `CHANGELOG.md`, and documentation relative to that commit.

### PASS

- Both checks in sections 6 and 7 meet every expected result, with the runtime identity gate passing. Their
  automated runs supply this evidence step by step: a step that a run reports as PASS counts as run as written, a
  step it reports as PASS (substitute) counts only where its section says so, and every other step is run by hand.
- After tagging, the exit checks in section 9 pass: the Secure Hash Algorithm (SHA-256) digests from CI,
  publishing, the Marketplace, and the GitHub release are equal, and the Marketplace lists the version without the
  pre-release property.

### FAIL

- Any expected result in sections 6 or 7 is wrong while the identity gate passes. Fix the defect and publish a new
  pre-release before starting a new campaign.

### INVALID RUN

- The identity gate shows a different version, a local instead of a remote window, or a host other than the web.
- The release commit changes shipped code relative to the tested pre-release (section 8 checks this).

### Falsifier

- A complete-file review that changes the repository (section 6), a hunk-only view that still shows `i/` or `w/`
  prefixes (section 7), a missing-repository prompt when opening a patch on the web, or **Copy Diagnostics**
  failing or giving another reason on the web disproves readiness.

## 3. Identities for the current campaign

| Item | Value | Evidence |
| --- | --- | --- |
| Release version | `0.3.9` | Higher than the latest pre-release, as [RELEASING.md](RELEASING.md#release-channels) requires |
| Pre-release under test | `0.3.8` | Marketplace download, 2026-11-26 |
| Its source commit | `67233b994e618358167afdf38038ab085de1bcbc`, rewritten as `429fb68c5be5f60a799a560ddf89c68fb7287679` | The commit Publish run `45571963415` built; CI run `45571178534` and CodeQL run `45571178621` passed on it. The rewrite changed only this runbook in that commit, and a pre-release package of the rewritten commit equals the Marketplace package in all 25 files (section 13) |
| Its package SHA-256 | `91088dda741cc101f752a0bb3143530b002bc5ba4e4c2dbe2aeb1d8567d96688` | The Marketplace download, whose 25 files equal a package built locally from the source commit; the digests of packaging job `139062168765` and publish job `139062760108` were not compared (section 12) |
| Remote-check patch | `git format-patch -1 eabcdbe`, four files, parent `d5d2748` | `git show --stat eabcdbe`; before the rewrite, `ad2e6ec` and `0aef85b` |
| Release commit and tag | `889b167dfd1f1a18a850c8af985f4ffd89a2a18f`, tag `v0.3.9`; `main` was force-pushed to it with the rewritten history | The tag ref resolves to that commit (section 12) |

## 4. Stop rules

- STOP before tagging unless both manual checks passed and section 8's diff gate passed.
- STOP if a check needs a code change: that change must ship as a pre-release first, then the checks repeat.
- STOP if the section 3 source commit is not on GitHub `main` after the push, for example after a rebase: its
  identities are void until section 3 names the commit the Publish run actually built. The one exception is a
  history rewrite that keeps every shipped file: section 3 then names both commits, and a pre-release package
  built from the rewritten commit must equal the Marketplace package file for file.
- A published version can never be withdrawn or reused. A mistake after publishing is fixed forward with the next
  patch version.
- Never paste credentials, tokens, or private patches into these checks. Use the patches named here.

## 5. Runtime identity gate

Run **View Patch: Copy Diagnostics** and paste the result into a new untitled editor. Required:

| Check | Remote window (section 6) | vscode.dev (section 7) |
| --- | --- | --- |
| First line | `View Patch` and the section 3 pre-release version | the same |
| `Remote:` | `ssh-remote` or another remote name | `(none)` |
| `Platform:` | the host's operating system and Node.js version | `browser (no Node.js)` |
| `Git version:` | `git version …` | `unavailable: VS Code for the Web cannot run Git.` (0.3.4 and later) |

A different first line, `Remote:`, or `Platform:` makes the check INVALID. With those right, a different
`Git version:` on vscode.dev is a FAIL (section 10); in the remote window it means Git is not on the host's
`PATH`, and the check is INVALID. The newest regular version, in section 11's last row, means the regular
release is installed: choose **Switch to Pre-Release Version** in the Extensions view, reload, and run the gate
again. An older pre-release means the new one has not reached this editor yet: update the extension, reload, and
run the gate again. If the version still does not change, auto update may be off for that install (section 10).

## 6. Manual check A: a real remote window

Preconditions: a VS Code window connected through Remote - SSH to a host with Git on `PATH` and a clone of this
repository that contains `eabcdbe`; View Patch installed on the remote side; the folder trusted. Two more come from
attempt 1 (section 12):

- Use a clone that nothing else writes to during the check, such as a fresh one. The object counts below cannot
  tell View Patch's writes from anyone else's.
- Open the clone in a new window after installing the version under test. A window that is already open keeps
  running the version it loaded until **Restart Extensions**.

```bash
# On the remote host: a fresh clone, opened in its own window
CLONE="$HOME/vp-check-a"
git clone https://github.com/waddahmoghram/vscode-view-patch.git "$CLONE"
code "$CLONE"
```

Run the rest of this section in that new window, with `CLONE` set again in its terminal.

```bash
# On the remote host, in the clone
cd "${CLONE:?set CLONE to the repository clone}"
git cat-file -e 'eabcdbe^{commit}' && echo "check commit present"
git status --short
git count-objects -v | grep -E '^(count|in-pack):'
```

Expected: `check commit present`, no `git status` output, and two counts to compare after the check.

```bash
git format-patch -1 eabcdbe --stdout > remote-check.patch
code remote-check.patch
```

1. Run the identity gate (section 5).
2. Run **View Patch: Open Patch as Changes**. Expected: one Changes view with four files (`TEST_PLAN.md`,
   `src/patchText.ts`, and two unit test files), and **Patch Reviews** showing this clone with the base
   `eabcdbec06950075f15d24526eb1b7041c7e886d^`, which is `d5d2748`.
3. Mark one file reviewed, then run **View Patch: Refresh Review**. Expected: the review refreshes and the
   checkmark remains.
4. Run **View Patch: View Patch Hunks Only**. Expected: the review switches to the same four files' hunks, labeled
   partial context. Opening a patch again reuses its review and tab, so **Patch Reviews** still lists one review.
5. Close the review's last tab. Expected: the review leaves **Patch Reviews**; no unrelated editor closes.

```bash
rm remote-check.patch
git status --short
git count-objects -v | grep -E '^(count|in-pack):'
```

Expected: no `git status` output, and the same two counts as before. Any change is a FAIL: complete-file reviews
must leave the repository unchanged.

### Automated check A

The Release checks workflow, [`release-checks.yml`](.github/workflows/release-checks.yml), runs check A after every
successful Publish run, and by hand from the **Actions** tab, with
[`scripts/release-checks/remote.mjs`](scripts/release-checks/remote.mjs). It downloads the version from the
Marketplace, makes a fresh clone and both patches, installs the package into an empty profile, and runs this
section's steps and the RELEASING.md extras through View Patch's commands, with the counts before and after. Its
report numbers the extras `1a` (the title), `3a` (switching modes with a second review open), and `5a` (**Show View
Patch Output**). Each job adds its step table to the run's summary and keeps it, with View Patch's log, as an
artifact.

- **Check A (Remote - SSH)** connects a VS Code test instance through Remote - SSH to the runner itself, through a
  Secure Shell (SSH) server and keys made for that run, with the package installed on the remote side. Its PASS is
  check A as written. It runs only when the repository variable `VSCODE_SERVER_LICENSE` is `accepted`, because it
  installs the Remote - SSH extension and a VS Code Server ([RELEASING.md](RELEASING.md#release-check-sign-ins)).
- **Check A (local test instance)** runs the same steps in a local window, on Linux and on Windows, so its report
  marks each step in the window as PASS (substitute). Of those, steps 3, 3a, 4, and 5a count, as the substitute's
  steps 3 and 4 did for 0.3.8 (section 12): they do not depend on where the extension host runs. The identity
  gate, the title, and steps 2 and 5 still need a real remote window: the Remote - SSH job, or a person following
  this section, with its preflight and after-check. On Windows, step 1a also shows a local window's title,
  `v<version> · local Windows`. That job has not run yet, so until it passes once, its failure does not fail the
  workflow.

To run it on a workstation, from a clone with `npm ci` done (on Linux without a display, prefix `xvfb-run -a`):

```bash
npm run check:a -- --version 0.3.9 --channel regular
```

With `--ssh <host>`, it connects to that host through Remote - SSH with the workstation's own SSH configuration
and keys, which makes it check A as written; it then also needs `--accept-server-license`, which accepts the
licenses above for that run.

## 7. Manual check B: public vscode.dev

1. Open <https://vscode.dev>, install **View Patch** from the Extensions view, then choose **Switch to
   Pre-Release Version**. Expected: no message that it is unavailable in VS Code for the Web. Use one vscode.dev
   tab, reloaded after any update: a tab keeps running the version it loaded.
2. Run the identity gate (section 5).
3. Run **View Patch: Open Sample Patch**. Expected: a hunk-only review of the built-in sample.
4. Copy this diff, then run **View Patch: Open Patch from Clipboard** and allow clipboard access if asked:

   ```diff
   diff --git i/hello.txt w/hello.txt
   index 1111111..2222222 100644
   --- i/hello.txt
   +++ w/hello.txt
   @@ -1 +1 @@
   -Hello
   +Hello, View Patch
   ```

   Expected (0.3.4 and later): no error prompt; a hunk-only review opens directly, and the first such review in
   the session shows a notice that VS Code for the Web cannot run Git. The review lists `hello.txt`, not
   `i/hello.txt`. Before 0.3.4 an error-styled prompt appeared instead (section 12, attempt 1).
5. Mark `hello.txt` reviewed. Expected: it shows as reviewed. View Patch does not save clipboard or sample
   patches for **Reopen Recent Patch...**, because they open as unsaved documents; steps 6 and 7 test saving with a
   file.
6. Open <https://vscode.dev/github/microsoft/vcpkg/blob/master/ports/zlib/0001-no-version-script-on-ohos.patch>,
   a real patch on GitHub, and sign in to GitHub: vscode.dev asks even for a public repository. Upstream now
   writes this patch with `a/` and `b/`; step 4 covers `i/` and `w/`. With its tab active, run **View Patch: Open
   Patch as Changes**. Expected: no "No Git repository was found" warning, and a hunk-only review listing
   `CMakeLists.txt`, with no `a/` or `i/` prefix.
7. Mark `CMakeLists.txt` reviewed, reload the page, run **View Patch: Reopen Recent Patch...**, and choose that
   patch. Expected: the review reopens with `CMakeLists.txt` still marked reviewed.
8. On the reloaded page, repeat step 4. Expected: as in step 4.

If a result differs, copy the **View Patch** output (Ctrl+Shift+U, then choose **View Patch**) before reloading
or leaving the page: a reload clears it, and it records which code path ran.

### Automated check B

The Release checks workflow also runs check B, with
[`scripts/release-checks/web.mjs`](scripts/release-checks/web.mjs): headless Chromium on public vscode.dev in a new
browser profile, View Patch installed from the Extensions view and switched to the pre-release for a pre-release
version, then every step above and the RELEASING.md browser extras, which its report numbers `2a` (the empty
view's title and buttons, **Show Environment**, and **Show View Patch Output**) and `5a` (no mode switch in the
review menus). Its steps 1 to 5 and 8 and the extras count as written. Steps 6 and 7 need a GitHub sign-in:

- With the repository secret `VSCODE_DEV_SIGN_IN_STATE`, a stored vscode.dev session
  ([RELEASING.md](RELEASING.md#release-check-sign-ins)), the run opens the GitHub patch as written, and its PASS
  counts. A session that expired or was revoked fails step 6 with "vscode.dev is not signed in to GitHub".
- Without it, they run through the substitute used since 0.3.6: the `i/` and `w/` copy of the patch, saved in the
  browser's private file storage, reported as PASS (substitute). That does not count; run steps 6 and 7 by hand in
  a signed-in session, or with a signed-in browser profile on a workstation:

```bash
npm run check:b -- --sign-in --profile vscode-dev-profile
npm run check:b -- --version 0.3.9 --channel regular --profile vscode-dev-profile
```

The first command opens a browser on that profile, waits until you have signed in to GitHub there, and runs
nothing else; later runs reuse the profile. Keep the profile folder private: it holds that GitHub sign-in.

## 8. Cut the release

The release commit sets `version` in `package.json` and `package-lock.json` to the release version, adds its
`CHANGELOG.md` section, and updates any documentation the checks settled. Make it on top of the tested
pre-release's source commit from section 3, then confirm it changes no shipped code relative to that commit:

```bash
tested=429fb68
release="$(git rev-parse HEAD)" # the release commit
git diff --stat "$tested" "$release" -- . ':(exclude)*.md' ':(exclude).github' ':(exclude).vscodeignore'
git diff "$tested" "$release" -- package.json
```

Expected: only `package.json` and `package-lock.json`, and only their version lines. Anything else is INVALID for
this campaign. Then bring the release commit into `main`: a merge when `main` has moved past the source commit, as
it had for 0.3.7, otherwise a fast-forward. Push `main`, wait for CI and CodeQL to pass on it, and push the tag on
the release commit itself, so the tag builds the tested code with the tested packaging tools:

```bash
git switch main
git merge --ff-only "$release"
git push origin main
git tag v0.3.9 "$release"
git push origin v0.3.9
```

For 0.3.9, which follows the history rewrite (section 13), `main` cannot fast-forward. It is force-pushed to the
release commit instead, with a lease on the old tip:

```bash
git push --force-with-lease=main:67233b994e618358167afdf38038ab085de1bcbc origin main
```

Tags `v0.3.5` and `v0.3.7` move to their rewritten commits the same way, with the Publish workflow disabled
meanwhile, because pushing a version tag starts it.

The tag starts the Publish workflow as a regular release. Its verify job runs CI on the tagged commit, and its
first publish steps refuse a tag that does not match `package.json`; both happen before anything is uploaded.

## 9. Exit verification

1. In the Publish run, all jobs pass except Open VSX, which is skipped unless enabled.
2. On the run's **Summary** page, `Packaged view-patch.vsix (regular)` and `Publishing view-patch.vsix (regular)`
   show the same SHA-256.
3. After the Marketplace scan, usually under ten minutes, compare the registry and the GitHub release:

```bash
version=0.3.9
curl -sL --compressed -o "marketplace-${version}.vsix" \
  "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/waddahmoghram/vsextensions/view-patch/${version}/vspackage"
curl -sL -o "github-${version}.vsix" \
  "https://github.com/waddahmoghram/vscode-view-patch/releases/download/v${version}/view-patch.vsix"
sha256sum "marketplace-${version}.vsix" "github-${version}.vsix"
unzip -p "marketplace-${version}.vsix" extension.vsixmanifest | grep -c 'Code.PreRelease'
```

Expected: both digests equal the Summary digest, and the last command prints `0`: a regular package carries no
pre-release property. Any mismatch: stop announcing the release and investigate the publish path.

### Automated exit verification

The Release checks workflow's exit job runs [`scripts/release-checks/exit.mjs`](scripts/release-checks/exit.mjs) on
each successful Publish run, with the workflow's own token, which can read the job logs that hold step 2's Summary
lines. It waits up to 30 minutes for the Marketplace to list the version, then requires every digest it found to
be equal: the CI package job's, the publish job's, an Open VSX job's when one ran, the Marketplace listing's
`VsixSha256` property, the Marketplace download, and for a tag the GitHub release asset's listed digest, its
download, and the digest its notes name. The channel must agree everywhere, and a tag's release must be regular and
not a draft. Its PASS completes steps 1 to 3. On a workstation it needs a token that can read the run's logs, such
as the one the GitHub command-line tool `gh` holds; without one, it reports the job digests as NOT RUN and the
verdict as INCOMPLETE:

```bash
GITHUB_TOKEN="$(gh auth token)" npm run check:exit -- --run <Publish run id>
```

## 10. Failure matrix

| Symptom | Meaning | Action |
| --- | --- | --- |
| The identity gate shows the newest regular version, in section 11's last row | The regular channel is installed | Switch to the pre-release and rerun the gate |
| The identity gate shows an older pre-release | The new version has not reached this editor | Update the extension, reload, and rerun the gate |
| The identity gate keeps an older version after switching or updating and reloading | Auto update is off for that install, as after installing from a `.vsix` file or a specific version, so it stays on that version | Right-click View Patch in that window's installed list, choose **Install Another Version**, and pick the version under test; reload and rerun the gate. Turn its **Auto Update** item back on after the campaign |
| "No Git repository was found" in check A | The patch is outside the clone, or Git is missing | Fix the precondition; the run is INVALID |
| "No Git repository was found" on vscode.dev, with the gate showing 0.3.4 or later | Regression of the web hunk-only fix | FAIL |
| `Git version:` on vscode.dev gives another reason, with the gate showing 0.3.4 or later | Regression of the web diagnostics wording | FAIL |
| A trust prompt in check A | The remote folder is not trusted | Trust it, or the run is INVALID |
| **Copy Diagnostics** fails on vscode.dev | Regression of the web diagnostics fix | FAIL |
| The web review shows `i/hello.txt` | Regression of the mnemonic-prefix fix | FAIL |
| The tag check fails | The tag and `package.json` disagree | Nothing was published; correct the version or tag |
| "already exists" when publishing | The version was used before | Choose the next patch version |
| The GitHub release step fails after publishing | The Marketplace has the version, GitHub does not | Attach the verified CI artifact to a release by hand, then check its digest |
| Publish jobs stay **Queued**, then the run fails with publishing skipped | A GitHub Actions incident; nothing was published | Confirm the Marketplace lacks the version and <https://www.githubstatus.com> shows recovery, then start a new run with the same pre-release choice |
| The Release checks exit job is INCOMPLETE | It ran without a Publish run id or without a token, so the job digests were not compared | Start it by hand with the Publish run id, or compare the Summary lines by hand (section 9) |
| The exit job fails at **Marketplace listing** | The Marketplace had not listed or validated the version within 30 minutes | Re-run the failed job later |
| Automated check B fails step 6 with "vscode.dev is not signed in to GitHub" | The stored vscode.dev session expired or was revoked | Refresh `VSCODE_DEV_SIGN_IN_STATE` ([RELEASING.md](RELEASING.md#release-check-sign-ins)) and re-run the job, or run steps 6 and 7 by hand |
| The job **Check A (Remote - SSH)** is skipped | The repository variable `VSCODE_SERVER_LICENSE` is not `accepted` | Run check A's remote parts by hand (section 6), or set the variable |

## 11. Release record

| Version | Channel | Published | Source commit | Check A | Check B | Package SHA-256 (CI = publish = Marketplace) |
| --- | --- | --- | --- | --- | --- | --- |
| 0.3.0 | regular | 2026-11-10 | `1f89c6c` | not recorded | not recorded | not comparable: rebuilt at publish |
| 0.3.5 | regular | 2026-11-11 | `82110ca` | PASS on 0.3.4, 2026-11-11 | PASS on 0.3.4, 2026-11-11 | `661153806417c5cfc8fe5000a0cc5ee0b5e1a646ae18dd43bf3def316693a3c6`, also equal to the GitHub release asset |
| 0.3.7 | regular | 2026-11-24 | `658e11e` | PASS on 0.3.6, 2026-11-24 | PASS on 0.3.6, 2026-11-24 | `185c6d9881a67dcd65467e5dd5a6003ba6ed3f83d048bc0d1160553101639de4`, also equal to the GitHub release asset |
| 0.3.9 | regular | 2026-11-26 | `889b167` | PASS on 0.3.8, 2026-11-26, steps 3 and 4 in a substitute | PASS on 0.3.8, 2026-11-26 | `2f240c662445a8b5d9e5b428bf4fbdd62ebe1a62b5c89a1112f30b6f58c1e46d` from the publish job and the Marketplace, also equal to the GitHub release asset; the packaging job's log was not read |

Pre-releases need no manual checks; [RELEASING.md](RELEASING.md#release-channels) lists them.

## 12. Commands actually run

On 2026-11-11 the section 9 digest comparison was run for the 0.3.2 and 0.3.3 pre-releases: each Marketplace
download matched its packaging and publishing digests (`96afd402…21bb79` and `d3bebc93…26cfaa`).

The same day, on a Linux clone and without VS Code, these commands were dry-run to confirm they behave as written:

- Section 6 preflight: `check commit present`, and the `ad2e6ec` patch contains four `diff --git` sections.
- Section 8 diff gate: valid syntax; it printed nothing because no release commit existed yet.
- Section 9 Marketplace commands with `version=0.3.3`: digest `d3bebc93…26cfaa`, and the pre-release property count
  printed `1`, as expected for a pre-release.

As first written, the manual checks in VS Code, the tag path, and the GitHub release download had not run; they
stay proposed until a campaign records them here. Attempt 1 below is the first manual run. The tag path and the
GitHub release download still have not run. (Later the same day, both ran for the first time, for 0.3.5; see the
release and exit verification below.)

The corrected section 8 gate was dry-run the same day with `tested=a42956a` while `HEAD` was that commit. Both
commands printed nothing, which shows only that their syntax is valid, and `git branch -r --contains a42956a`
printed nothing, as expected before the push.

### Attempt 1: pre-release 0.3.3, 2026-11-11 (stopped, no verdict)

This attempt targeted regular 0.3.4. Its identities, moved here from section 3 by the
[review correction](#2026-11-11---review-correction):

| Item | Value | Evidence |
| --- | --- | --- |
| Release version | `0.3.4`, withdrawn | Section 13 |
| Pre-release under test | `0.3.3` | Marketplace, validated 2026-11-11 |
| Its source commit | `8dc16e104aa23b3ee19ac6824bcdb11d302e4947` | `main` after `git push`, 2026-11-11 |
| Its package SHA-256 | `d3bebc93b9a0787708e209caca0584565119b43963ee3fc0cae4e6d41826cfaa` | Packaging job, publish job, and Marketplace download all equal (Publish run 43069223565) |

Check B ran on vscode.dev in Visual Studio Code 1.146.0. Results as reported:

| Step | Result | Observation |
| --- | --- | --- |
| 1. Install and switch | Not recorded separately | Step 2 ran in vscode.dev, so the pre-release was installed there |
| 2. Identity gate | PASS, with finding 1 | The diagnostics below |
| 3. Sample patch | Not reported | None |
| 4. Clipboard patch | INCOMPLETE, finding 2 | Two opens, both stopped at the prompt; **View Hunks Only** was not chosen |
| 5. Reload and reopen | Not run | None |

Diagnostics, as pasted from step 2:

```text
View Patch 0.3.3
Editor: Visual Studio Code 1.146.0 (vscode.dev)
Remote: (none)
Platform: browser (no Node.js)
Workspace folders: 0; trusted: true
Git executable: git
Git version: unavailable: Home-folder (~) viewPatch.repositories entries are not available in VS Code for the Web.
Git extension repositories: (unavailable)
viewPatch.repositories entries: 0
Open reviews: 0
```

View Patch output from step 4, in the browser's local time:

```text
2026-11-11 10:47:22.704 [info] Untitled-2: commit (none); repositories: (none)
2026-11-11 10:47:22.705 [warning] Untitled-2: No Git repository was found. Open its repository or choose a hunk-only view.
2026-11-11 10:47:35.961 [info] Untitled-1: commit (none); repositories: (none)
2026-11-11 10:47:35.961 [warning] Untitled-1: No Git repository was found. Open its repository or choose a hunk-only view.
```

- Finding 1, wording: the `Git version:` reason blamed home-folder repository entries, though none were
  configured. The probe ran Git from the home folder, and the web stand-in for that folder failed first. The real
  reason is that VS Code for the Web cannot run Git.
- Finding 2, usability: opening a patch on the web showed a warning that no Git repository was found, with
  choices that need Git. It read as an error, and the hunk-only choice was easy to miss.

The regular 0.3.0 has the same prompt, and its **Copy Diagnostics** fails on the web outright (fixed in 0.3.2).

Check A was still running on 0.3.3 when this record was written. Whatever its result, it repeats on 0.3.4.

Update, later on 2026-11-11: check A on 0.3.3 stopped before any step in the editor, so it has no result. The
remote window's extension host had run since 2026-11-10 00:34:43 -08:00 and still ran View Patch 0.2.0, the version
installed when it started. 0.2.0 has no **Copy Diagnostics** command, and 0.3.3, installed at 10:51:37 -08:00, would
load only after **Restart Extensions**. View Patch's log in that host was last written on 2026-11-10, so no step had
run. The identity gate would have rejected the attempt, and the commits made in that clone meanwhile would have
changed its object counts. Section 6's two added preconditions come from this.

Verdict: none. The attempt stopped under section 4's second rule: the fix, `efe7f82`, changes shipped code, so it
ships as pre-release 0.3.4 and both checks repeat on it. The three web tests covering the findings fail against
0.3.3 and pass at `efe7f82`.

### Attempt 2: pre-release 0.3.4, 2026-11-11 (checks pending)

The push moved GitHub `main` from `8dc16e1` to `11d4838`. CI run `43093095901` and CodeQL run `43093095881` passed
on `11d4838`. Publishing took two runs, both started by hand. Run #7's logs show the pre-release choice; run #6
never reached a step that reports it.

| Publish run | Attempt | Result | Observation |
| --- | --- | --- | --- |
| `43094937518` (#6) | 1 | Failed; nothing published | The four test jobs passed. **Web tests** and **package** waited for an `ubuntu-latest` runner from 20:21:25Z and never started. The run ended at 21:00:44Z with publishing skipped. GitHub's [incident](https://stspg.io/jdjlq5zjyl48) put Actions in a major outage at 20:48:25Z and mitigated it at 21:07:24Z. The Marketplace still had 0.3.3 as its newest version. |
| `43102614491` (#7) | 1 | Cancelled | Every job was cancelled 35 seconds in (21:23:25Z to 21:24:00Z), before any test finished. The operator cancelled it by mistake, as he reported later that day; nothing had been published. |
| `43102614491` (#7) | 2 | Passed | Every job passed, with Open VSX skipped as configured. Publishing finished at 21:34:15Z. |

Log excerpts from attempt 2's package and publish jobs:

```text
Packaged view-patch.vsix (pre-release), SHA-256 a137394114b6437a08cd2212d975ac25c272a426302ad8a1d50eb7674383219b
Publishing view-patch.vsix (pre-release), SHA-256 a137394114b6437a08cd2212d975ac25c272a426302ad8a1d50eb7674383219b
Published waddahmoghram.view-patch v0.3.4.
```

Section 9's Marketplace commands, run with `version=0.3.4` at 21:35:45Z, gave the same digest and a pre-release
property count of `1`. The package's manifest reads `Version="0.3.4"`, and its `extension/dist/web/extension.js`
contains `VS Code for the Web cannot run Git`. A pre-release has no GitHub release to download.

The Marketplace's version listing, which editors use to find updates, lagged the download. A query at about
21:37Z still listed 0.3.3 as newest; at 21:40:26Z it listed 0.3.4, updated 21:38:23Z.

Section 4's stop rule for the source commit was checked against GitHub directly, because this clone has no remote:

```bash
git fetch https://github.com/waddahmoghram/vscode-view-patch.git main
git merge-base --is-ancestor a42956a FETCH_HEAD && echo "a42956a is on GitHub main"
git merge-base --is-ancestor 11d4838 FETCH_HEAD && echo "11d4838 is on GitHub main"
```

Both lines printed, and `FETCH_HEAD` was `11d48386a020248272add0d61e001482775fd9fc`.

Checks A and B ran on 0.3.4 the same afternoon. Times are the checker's local time, eight hours behind Coordinated
Universal Time.

**Check A: PASS.** It ran in a new remote window on a fresh clone (section 6), on Visual Studio Code 1.145.2.

| Step | Result | Observation |
| --- | --- | --- |
| Identity gate | PASS | `View Patch 0.3.4`, `Remote: ssh-remote`, `Platform: linux x64; Node 24.22.1`, `Git version: git version 2.34.1`, one trusted workspace folder |
| Preflight | PASS | Clone at `11d4838`: `check commit present`, no `git status` output, `count: 0`, `in-pack: 314` |
| 2. Open Patch as Changes | PASS | The four files. Log: `remote-check.patch: complete review r1; base ad2e6ec6e549fae93d5855921b761ae19538f95c^.` |
| 3. Mark and refresh | PASS | The mark stayed; the log shows the refreshed review as `r2` |
| 4. Hunks only | PASS | The same four files, labeled partial context. Log: `remote-check.patch: partial review r2; base (hunks only).` |
| 5. Close | PASS | Both reviews left **Patch Reviews**; no other tab closed |
| After | PASS | No `git status` output; `count: 0`, `in-pack: 314` |

Only three things under `.git` changed after the patch was written at 13:52:02. The `index` was refreshed at
13:52:02, and GitLens wrote its per-branch timestamps to `gk/config` at 13:52:03. Both came before View Patch
started at 13:54:58. The `.git` folder's own modification time changed at 14:06:12, from the closing `git status`.
No object, ref, or configuration file changed.

**Check B: PASS.** It ran on vscode.dev, Visual Studio Code 1.146.0. Steps 5 to 8 follow the
[Check B step 5 correction](#2026-11-11---check-b-step-5-correction), which was made before the checker reached
step 5.

| Step | Result | Observation |
| --- | --- | --- |
| 2. Identity gate | PASS | `View Patch 0.3.4`, `Remote: (none)`, `Platform: browser (no Node.js)`, `Git executable: (none)`, `Git version: unavailable: VS Code for the Web cannot run Git.` |
| 3. Sample patch | PASS | A hunk-only review |
| 4. Clipboard patch | PASS, with one unplaced report | Two opens on 0.3.4, logged below, with no warning |
| 5. Mark | PASS | `hello.txt` shown as reviewed |
| 6. GitHub patch | PASS | `CMakeLists.txt`, not `i/CMakeLists.txt`; no warning |
| 7. Reload and reopen | PASS | `CMakeLists.txt` still marked reviewed |
| 8. Clipboard on the reloaded page | PASS | No warning |

The **View Patch** output from step 4's page:

```text
2026-11-11 14:17:40.179 [info] Untitled-1: VS Code for the Web cannot run Git. Showing the patch's hunks only.
2026-11-11 14:17:40.314 [info] Untitled-1: partial review r1; base (hunks only).
2026-11-11 14:19:00.185 [info] Untitled-1: partial review r2; base (hunks only).
2026-11-11 14:19:18.342 [info] Untitled-1: VS Code for the Web cannot run Git. Showing the patch's hunks only.
2026-11-11 14:19:18.405 [info] Untitled-1: partial review r3; base (hunks only).
```

The unplaced report: the checker saw "No Git repository was found" on the first clipboard open. That page's output
was not captured, and the checker could not say whether the page had reloaded after the update. In 0.3.4 the
warning comes only from the complete-file path, which runs only when the host can run Git, and this build's
diagnostics showed that it cannot. With no runtime identity, the report is not evidence either way. Two
explanations fit: a tab still running 0.3.3, or the one-time notice, shown only on the first open, read as the old
error. Section 7 now asks for one reloaded tab and for the output to be copied before reloading.

Verdict for both checks: PASS on pre-release 0.3.4. Next come the release commit and tag (section 8) and the exit
verification (section 9).

### Release and exit verification: 0.3.5, 2026-11-11 (PASS)

The campaign's identities, moved here from section 3 when the 0.3.7 campaign started:

| Item | Value | Evidence |
| --- | --- | --- |
| Release version | `0.3.5` | Higher than the latest pre-release, as [RELEASING.md](RELEASING.md#release-channels) requires |
| Pre-release under test | `0.3.4` | Marketplace download, validated 2026-11-11T21:35:45Z |
| Its source commit | `11d48386a020248272add0d61e001482775fd9fc` | The commit Publish run `43102614491` built; it differs from the Release 0.3.4 commit `a42956a` only in this file |
| Its package SHA-256 | `a137394114b6437a08cd2212d975ac25c272a426302ad8a1d50eb7674383219b` | Packaging job `130801344413`, publish job `130802978286` (that run's attempt 2), and the Marketplace download all equal |
| Remote-check patch | `git format-patch -1 ad2e6ec`, four files, parent `0aef85b` | `git show --stat ad2e6ec` |
| Release commit and tag | `82110ca8dafaff981577d4c9890d9f9d1169aa01`, tag `v0.3.5` | The tag ref resolves to that commit, and GitHub `main` is at it (below) |

Before the push, the section 8 diff gate ran on the release commit `82110ca8dafaff981577d4c9890d9f9d1169aa01`
with `tested=11d4838`. Its `--stat` listed only `package.json` and `package-lock.json`, and the `package.json`
diff changed only the `version` line. A local regular package of that commit showed `Version="0.3.5"`, no
pre-release property, the same 21 files, and the web fix.

Times are Coordinated Universal Time.

| Step | Result | Evidence |
| --- | --- | --- |
| Push `11d4838..82110ca` | GitHub `main` at `82110ca` | The repository interface |
| CI and CodeQL on `82110ca` | Passed by 22:47:37, before the tag was pushed | Runs `43114003066` and `43114003001` |
| Tag `v0.3.5` | Points at commit `82110ca8dafaff981577d4c9890d9f9d1169aa01` | The tag ref |
| Publish run `43115767355`, started by the tag at 22:55:36 | Every job passed except Open VSX, which was skipped. The tag check passed, and neither log has an error marker | The job listing and logs |
| Package and publish jobs | Both log `view-patch.vsix (regular), SHA-256 661153806417c5cfc8fe5000a0cc5ee0b5e1a646ae18dd43bf3def316693a3c6`. The publish job then logs `Published waddahmoghram.view-patch v0.3.5.` and creates the GitHub release | Jobs `130845280815` and `130845541026` |
| GitHub release `v0.3.5` | Regular, not a draft, published 23:01:17. Its `view-patch.vsix` is 135,667 bytes, with digest `sha256:66115380…93a3c6` | The release interface |
| Section 9 commands with `version=0.3.5`, at 23:19:05 | Both downloads gave `661153806417c5cfc8fe5000a0cc5ee0b5e1a646ae18dd43bf3def316693a3c6`, both manifests read `Version="0.3.5"`, and the pre-release property count printed `0` | Command output |
| Listing | At 23:19:24, `0.3.5` was listed as a regular version, last updated 23:08:36.773, and was the newest regular version | A listing query |

Verdict: PASS. Every section 9 check held: the packaging, publishing, Marketplace, and GitHub release digests are
equal, and the Marketplace version carries no pre-release property. This was the first release published by pushing
a tag, and the tag path ran as designed. Open VSX was not part of this release.

### Checks on pre-release 0.3.6, 2026-11-24 (two runs pending as written)

This campaign targets regular 0.3.7. While 0.3.6's Publish run was under way, GitHub `main` moved from `6f0f88b`
to `3908c05` by merging Dependabot pull request #2, which updates the development dependency `@vscode/vsce` from
4.1.0 to 4.1.1 in `package.json` and `package-lock.json`. Section 8's gate would list that change for a release
commit on `3908c05`, so the release commit is made on `6f0f88b` instead (the
[0.3.7 campaign correction](#2026-11-24---037-campaign)). A package built from `3908c05` with `npx vsce package`
matched the Marketplace 0.3.6 package in every file except that dependency line in `package.json` and the
manifest's pre-release property, so the update changes no shipped code.

Both checks were automated, driving headless Chromium through Playwright, without a GitHub sign-in. Times are
the checker's local time, eight hours behind Coordinated Universal Time.

**Check A: every expected result held, in a substitute environment.** The automated run had no Remote - SSH window. It
ran `code serve-web` 1.147.0 on the Linux host, bound to `127.0.0.1` with a connection token: the same
server-side extension host and the host's Git, with the editor in a browser. View Patch reads the remote name only
for **Copy Diagnostics**, and decides whether it can run Git from the Node.js runtime (`hostRunsGit` in
[`src/controller.ts`](src/controller.ts)), so it takes the same code paths as in a Remote - SSH window. The clone
was a fresh `~/vp-check-a` at `3908c05`, trusted and used by nothing else.

| Step | Result | Observation |
| --- | --- | --- |
| Preflight | PASS | `check commit present`, no `git status` output, `count: 0`, `in-pack: 491` |
| 1. Identity gate | PASS | `View Patch 0.3.6`, `Remote: 127.0.0.1:38517`, `Platform: linux x64; Node 24.22.1`, `Git version: git version 2.56.1`, one trusted workspace folder |
| 2. Open Patch as Changes | PASS | The four files. Log: `remote-check.patch: complete review r1; base ad2e6ec6e549fae93d5855921b761ae19538f95c^.` |
| 3. Mark and refresh | PASS | `src/patchText.ts` stayed reviewed; the log shows the refreshed review as `r1` |
| 4. Hunks only | PASS, as corrected | The same four files, labeled partial context, in the same review and tab. Log: `remote-check.patch: partial review r1; base (hunks only).` |
| 5. Close | PASS | The review left **Patch Reviews**; `remote-check.patch` stayed open |
| After | PASS | No `git status` output; `count: 0`, `in-pack: 491` |

The only write under `.git` after the clone was `branch.main.vscode-merge-base = origin/main` in `.git/config`, at
11:45:46, as the folder was trusted. VS Code's built-in Git extension writes that key when it opens a repository,
and a screenshot two seconds later shows the folder trusted and the branch in the status bar. No View Patch command
had run yet: the first came after the switch to the pre-release finished at 11:47:32. No object, ref, or reflog
changed.

While a review tab is active, its accessible label ends in ", preview", but the tab is kept: its title is not
italic, and a single click on `README.md` in the Explorer opened a separate preview tab without replacing it.

**Check B: steps 1 to 5 and 8 passed; steps 6 and 7 ran with a substitute.** It ran on vscode.dev, Visual Studio
Code 1.147.0.

| Step | Result | Observation |
| --- | --- | --- |
| 1. Install and switch | PASS | Only the publisher-trust prompt and the notice that View Patch has limited functionality in VS Code for the Web; no message that it is unavailable |
| 2. Identity gate | PASS | `View Patch 0.3.6`, `Remote: (none)`, `Platform: browser (no Node.js)`, `Git version: unavailable: VS Code for the Web cannot run Git.` |
| 3. Sample patch | PASS | A hunk-only review of `src/greeting.ts` and `README.md` |
| 4. Clipboard patch | PASS | The one-time web notice and no error prompt; the review lists `hello.txt` |
| 5. Mark | PASS | `hello.txt` shown as reviewed |
| 6. GitHub patch | Not run as written | vscode.dev/github asked for a GitHub sign-in for the public vcpkg repository, and the automated run does not sign in |
| 6. Substitute | PASS | The same patch rewritten with `i/` and `w/`, saved in the browser's private file storage and opened with **File: Open File...**, the automation answering the file picker: no Git warning, and the review lists `CMakeLists.txt` |
| 7. Substitute | PASS | After marking it and reloading, **Reopen Recent Patch...** listed it as hunks only, and it reopened with `CMakeLists.txt` still reviewed |
| 8. Clipboard on the reloaded page | PASS | No warning. Output: `Untitled-7: VS Code for the Web cannot run Git. Showing the patch's hunks only.` |

The substitute runs the same open, mark, reload, and reopen flow, from a different file system than GitHub's. The
0.3.6 changes to shipped code, in `src/controller.ts`, `src/extension.ts`, and the new `src/problemReport.ts`, add
**Report a Problem...**, path redaction, and drop handling; they do not change how a patch file is read.

One finding outside the expected results: a reviewed file's row in **Patch Reviews** takes its accessible label
from its tooltip, which never says "reviewed" (`src/reviews.ts`). It predates 0.3.6 and does not block this
release.

### Checks A and B as written: pre-release 0.3.6, 2026-11-24 (PASS)

The two runs that had used substitutes ran as written the same afternoon. The operator worked the editor, and the
shell steps ran on the host, where View Patch's output was also read. Times are the host's local time, eight
hours behind Coordinated Universal Time.

**Check A: PASS.** It ran in a new Remote - SSH window on the same Linux host, on Visual Studio Code 1.147.0, with
a fresh `~/vp-check-a` at `745f94a`, trusted and used by nothing else. A first try in a local window stopped at the
identity gate (`Remote: (none)`, `Platform: win32 x64`), as section 5 requires. On the host, View Patch had stayed
on 0.3.5 with auto update turned off (section 10), so 0.3.6 was installed with
`code --install-extension waddahmoghram.view-patch@0.3.6` at 13:13, and the window was reloaded.

| Step | Result | Observation |
| --- | --- | --- |
| Preflight | PASS | `check commit present`, no `git status` output, `count: 0`, `in-pack: 512` |
| 1. Identity gate | PASS | `View Patch 0.3.6`, `Remote: ssh-remote`, `Platform: linux x64; Node 24.22.1`, `Git version: git version 2.56.1`, one trusted workspace folder |
| 2. Open Patch as Changes | PASS | The four files. Log: `remote-check.patch: complete review r1; base ad2e6ec6e549fae93d5855921b761ae19538f95c^.` |
| 3. Mark and refresh | PASS | The mark stayed; the log shows the refreshed review as `r1` |
| 4. Hunks only | PASS | One review, of the same four files, labeled partial context. Log: `remote-check.patch: partial review r2; base (hunks only).` |
| 5. Close | PASS | The review left **Patch Reviews**; `remote-check.patch` stayed open |
| After | PASS | No `git status` output; `count: 0`, `in-pack: 512` |

Step 4's review is `r2`, not `r1`: by then `r1` was no longer open, since the operator saw one review and View
Patch reuses only an open review of the same source. A **Copy Diagnostics** after step 5 logged `Open reviews: 0`.

Under `.git`, only `config` (`vscode-merge-base`) and the commit-graph files changed at 13:00:43, as the first
check window opened, and GitLens wrote `gk/config` at 13:35:32. All came before View Patch's first review command,
at 13:38:10. No object, ref, or reflog changed.

**Check B steps 6 and 7: PASS.** They ran in the operator's own vscode.dev session, signed in to GitHub. The
identity gate showed `View Patch 0.3.6`, `Editor: Visual Studio Code 1.147.0 (vscode.dev)`, `Remote: (none)`,
`Platform: browser (no Node.js)`, and `Git version: unavailable: VS Code for the Web cannot run Git.`

| Step | Result | Observation |
| --- | --- | --- |
| 6. GitHub patch | PASS | **Open Patch as Changes** went straight to hunks only, with no Git warning; the review lists `CMakeLists.txt`, with no `a/` prefix |
| 7. Reload and reopen | PASS | After marking it and reloading, **Reopen Recent Patch...** reopened the review with `CMakeLists.txt` still reviewed |

The **View Patch** output from step 6, in the browser's local time, one hour ahead of the times above:

```text
2026-11-24 14:53:18.947 [info] 0001-no-version-script-on-ohos.patch: partial review r1; base (hunks only).
2026-11-24 14:55:46.418 [info] 0001-no-version-script-on-ohos.patch: VS Code for the Web cannot run Git. Showing the patch's hunks only.
2026-11-24 14:55:46.482 [info] 0001-no-version-script-on-ohos.patch: partial review r2; base (hunks only).
```

The first line came from a hunks-only command, which logs no notice. The other two came from **Open Patch as
Changes**: on the web it chooses hunks only before any Git step, and only the complete-file path can raise "No Git
repository was found".

### Release and exit verification: 0.3.7, 2026-11-24 (PASS)

The campaign's identities, moved here from section 3 when the 0.3.9 campaign started:

| Item | Value | Evidence |
| --- | --- | --- |
| Release version | `0.3.7` | Higher than the latest pre-release, as [RELEASING.md](RELEASING.md#release-channels) requires |
| Pre-release under test | `0.3.6` | Marketplace download, 2026-11-24 |
| Its source commit | `6f0f88b1c3c28ab128e331c78ad48c3abe704060` | The commit Publish run `45348403770` built; CI run `45347481251` and CodeQL run `45347481178` passed on it |
| Its package SHA-256 | `e3d3f4de54507da3b6d9df4cd25d81d1cd34912b99d9cdee92e2e88f0a0ef8ab` | Packaging job `138289840286`, publish job `138290358037`, and the Marketplace download all equal |
| Remote-check patch | `git format-patch -1 ad2e6ec`, four files, parent `0aef85b` | `git show --stat ad2e6ec` |
| Release commit and tag | `658e11e73703b031e7beb909b5533fcd58caf02f`, tag `v0.3.7`, merged into `main` by `745f94a` | The tag ref resolves to that commit (below) |

Before the push, the section 8 diff gate ran on the release commit `658e11e73703b031e7beb909b5533fcd58caf02f`
with `tested=6f0f88b`. Its `--stat` listed only `package.json` and `package-lock.json`, and the `package.json`
diff changed only the `version` line. The merge commit `745f94a5e6e364fbbacccf07307282e40fbee22f` brought the
release commit into `main`.

Times are Coordinated Universal Time.

| Step | Result | Evidence |
| --- | --- | --- |
| Push `3908c05..745f94a` | GitHub `main` at `745f94a`, which also carries the dashboard fix `934cf27` | The repository |
| CI, CodeQL, and Quality dashboard on `745f94a` | Passed by 20:58:05, before the tag was pushed; the dashboard run uploaded its `dashboard-metrics` artifact | Runs `45484637041`, `45484637151`, and `45486158007` |
| Tag `v0.3.7` | Points at commit `658e11e73703b031e7beb909b5533fcd58caf02f` | The tag ref |
| Publish run `45496910322`, started by the tag at 22:01:42 | Every job passed except Open VSX, which was skipped; its verify job ran CI on the tagged commit | The job listing |
| Package and publish jobs | Both log `view-patch.vsix (regular), SHA-256 185c6d9881a67dcd65467e5dd5a6003ba6ed3f83d048bc0d1160553101639de4`. The publish job then logs `Published waddahmoghram.view-patch v0.3.7.` and creates the GitHub release | Jobs `138812507718` and `138813113393` |
| GitHub release `v0.3.7` | Regular, not a draft, published 22:07:58. Its `view-patch.vsix` is 140,219 bytes, with digest `sha256:185c6d98…639de4`, and its notes are the changelog section with that digest | The release |
| Section 9 commands with `version=0.3.7`, at about 02:04 on 2026-11-25 | Both downloads gave `185c6d9881a67dcd65467e5dd5a6003ba6ed3f83d048bc0d1160553101639de4`, the manifest reads `Version="0.3.7"`, and the pre-release property count printed `0` | Command output |
| Listing | At 02:04:31 on 2026-11-25, `0.3.7` was listed as a regular version, last updated 22:13:36.043, and was the newest version | A listing query |
| Shipped code | The Marketplace 0.3.7 package differs from the 0.3.6 package only in `changelog.md`, the `package.json` version line, and the manifest's version and pre-release property; `extension/out` and `extension/dist` are identical | `diff -r` of the two downloads |

Verdict: PASS. Every section 9 check held: the packaging, publishing, Marketplace, and GitHub release digests are
equal, and the Marketplace version carries no pre-release property. The tag was on the release commit, so the
package was built from the tested code with the tested packaging tools, as section 8 now requires.

### Checks on pre-release 0.3.8, 2026-11-26 (two runs pending as written)

This campaign targets regular 0.3.9. Pre-release 0.3.8 was published on 2026-11-25 by Publish run `45571963415`,
started by hand from `main` at `67233b9`. GitHub `main` has not moved since, so the release commit is made directly
on that commit, as the history rewrite renamed it, `429fb68` (section 13). Times are Coordinated Universal Time.

| Evidence | Result | Observation |
| --- | --- | --- |
| Publish run `45571963415` | Passed | The four test jobs, the web tests, package job `139062168765`, the installed-package smoke test, and publish job `139062760108` passed between 07:55:46 and 08:01:15 on 2026-11-25; Open VSX was skipped |
| Listing, 2026-11-26 | `0.3.8` is the newest version, a pre-release; `0.3.7` is the newest regular version | A listing query |
| Marketplace download | SHA-256 `91088dda741cc101f752a0bb3143530b002bc5ba4e4c2dbe2aeb1d8567d96688`; the manifest reads `Version="0.3.8"`, and the pre-release property count printed `1` | Section 9's Marketplace commands with `version=0.3.8` |
| Shipped files | All 25 files equal those of the pre-release package built locally from `67233b9`, on which the installed-package tests passed | A file-by-file comparison of the two packages |
| Rewritten source commit | A pre-release package built from `429fb68` equals the Marketplace package in all 25 files | A file-by-file comparison of the two packages |
| Packaging and publish job digests | Not read: the job logs and the run's **Summary** page need a GitHub sign-in, which the automated checks do not use | Still to compare (below) |

**Check B: steps 1 to 5 and 8 passed; steps 6 and 7 ran with a substitute.** An automated run drove headless
Chromium through Playwright on vscode.dev, Visual Studio Code 1.148.0, in a new browser profile and without a
GitHub sign-in.

| Step | Result | Observation |
| --- | --- | --- |
| 1. Install and switch | PASS | Only the publisher-trust prompt and the notice that View Patch has limited functionality in VS Code for the Web; no message that it is unavailable. The details then showed `pre-release` and version `0.3.8` |
| 2. Identity gate | PASS | `View Patch 0.3.8`, `Remote: (none)`, `Platform: browser (no Node.js)`, `Git version: unavailable: VS Code for the Web cannot run Git.` |
| 3. Sample patch | PASS | A hunk-only review of `src/greeting.ts` and `README.md` |
| 4. Clipboard patch | PASS | The one-time web notice and no error prompt; the review lists `hello.txt` |
| 5. Mark | PASS | `hello.txt` shown as reviewed; its spoken label changed from `hello.txt, modified, not reviewed, partial context` to `hello.txt, modified, reviewed, partial context` |
| 6. GitHub patch | Not run as written | vscode.dev asks for a GitHub sign-in, and the automated run does not sign in |
| 6. Substitute | PASS | As for 0.3.6: the `i/` and `w/` copy of the patch, saved in the browser's private file storage and opened with **File: Open File...**: no Git warning, and the review lists `CMakeLists.txt` |
| 7. Substitute | PASS | After marking it and reloading, **Reopen Recent Patch...** listed it as hunks only, and it reopened with `CMakeLists.txt` still reviewed |
| 8. Clipboard on the reloaded page | PASS | No warning. Output: `Untitled-4: VS Code for the Web cannot run Git. Showing the patch's hunks only.` |

The same session covered the browser part of the extra checks that [RELEASING.md](RELEASING.md#pre-releases)
lists for 0.3.8:

- The empty **Patch Reviews** view's title read `v0.3.8 · browser`, and all six welcome buttons showed. The title
  stayed the same while reviews were open.
- **Show Environment** said:
  `View Patch 0.3.8 is running in the browser, which cannot run Git, so patches open as hunks only.`
- **Show View Patch Output** selected the **View Patch** output channel, which held the **Copy Diagnostics** log.
- Each review's context menu offered **Change Repository and Base...**, **Compare with Another Patch...**,
  **Copy Review Summary as Markdown**, **Mark All Reviewed**, and **Clear Reviewed Checkmarks**, and no mode
  switch. Its inline actions were **Refresh Review** and **Close Review**.

**Check A: not run yet.** No substitute ran this time: `code serve-web`, which stood in for a Remote - SSH window
in the 0.3.6 checks, starts only after its server license terms are accepted, and accepting them is the
operator's decision.

Still to run on 0.3.8 before the tag, each as written:

- Check A (section 6) in a new Remote - SSH window, with the RELEASING.md extras: the title reads
  `v0.3.8 · remote Linux`, **Show View Patch Output** opens the log, and, with a second patch's review active,
  right-clicking the first review switches it to hunks only and back to complete files, keeping its target and
  reviewed marks and leaving the second review untouched.
- Check B's steps 6 and 7, in the operator's signed-in vscode.dev session.
- In a local window, the title names the local operating system, such as `v0.3.8 · local Windows`. With a screen
  reader, a file's label says "reviewed" or "not reviewed" as its mark changes, and "partial context".
- On Publish run `45571963415`'s **Summary** page, the `Packaged view-patch.vsix (pre-release)` and
  `Publishing view-patch.vsix (pre-release)` lines both show the section 3 digest.

### Checks A and B as written: pre-release 0.3.8, 2026-11-26 (PASS, two steps in a substitute)

The runs still pending above ran the same afternoon, after the rewritten history was pushed. The operator worked
the editor; the shell steps ran on the host, where View Patch's output was also read. Times are the host's local
time, eight hours behind Coordinated Universal Time.

**Check A: PASS, with steps 3 and 4 run again in a substitute.** It ran in a new Remote - SSH window on the Linux
host, on Visual Studio Code 1.148.0, with a fresh `~/vp-check-a` at `889b167`, trusted and used by nothing else.
The remote install had stayed on 0.3.7 with auto update off (section 10), so 0.3.8 was installed with the host's
VS Code Server command line, `code-server --install-extension waddahmoghram.view-patch@0.3.8`, before the window
opened. The second patch for the mode switches was `git format-patch -1 f9ce6f0`, the rewritten "Record the 0.3.7
release", which changes only this file.

| Step | Result | Observation |
| --- | --- | --- |
| Preflight | PASS | `check commit present`, no `git status` output, `count: 0`, `in-pack: 581` |
| Title | PASS | `v0.3.8 · remote Linux`, as the operator reported |
| 1. Identity gate | PASS | `View Patch 0.3.8`, `Remote: ssh-remote`, `Platform: linux x64; Node 24.22.1`, `Git version: git version 2.56.1`, one trusted workspace folder |
| 2. Open Patch as Changes | PASS | The four files. Log: `remote-check.patch: complete review r1; base eabcdbec06950075f15d24526eb1b7041c7e886d^.` |
| 3. Mark and refresh | Not shown in the window | The operator marked `src/patchText.ts`, but the log has no second `complete review r1` line, which every refresh writes, so **Refresh Review** did not run there. The substitute below ran it |
| Mode switches with a second review open | PASS | `second-check.patch: complete review r2`. With `r2`'s tab active, **Show Hunks Only for Review** on `r1` logged `partial review r1`, and **Show Complete Files for Review** logged `complete review r1` on the same base; nothing was logged for `r2`. The operator reported the mark kept |
| 4. View Patch Hunks Only | Not shown in the window | Both reviews had been closed and reopened as `r3` and `r4`, and `r3` was already showing hunks when the command ran: it logged `partial review r3` and opened no new review, but did not switch from complete files. The substitute below ran it |
| 5. Close | PASS | The operator closed the review tabs; View Patch logs a review's release only at debug level |
| Output | PASS | **Show View Patch Output** showed the log the operator copied |
| After | PASS | No `git status` output; `count: 0`, `in-pack: 581`; refs unchanged |

Under `.git`, only GitLens's `gk/config`, the commit-graph files, and `config` (`branch.main.vscode-merge-base`)
changed, at 12:22, before View Patch's first command at 12:23:36. No object, ref, or reflog changed.

The substitute ran steps 2 to 5 from 13:03 to 13:04 on the same host, with the same Git, editor version, and
package as the window, but in a Visual Studio Code 1.148.0 test instance instead of a remote window: the
Marketplace 0.3.8 package (`91088dda…96688`) in an empty profile, a fresh clone at `889b167`, and Workspace Trust
disabled, so the folder counts as trusted. A test runner called the same commands:

| Step | Result | Observation |
| --- | --- | --- |
| 2. Open Patch as Changes | PASS | `r1`, complete files, the four files, base `eabcdbec…^` |
| 3. Mark and refresh | PASS | After `src/patchText.ts` was marked, **Refresh Review** returned `r1` with complete files and one file reviewed |
| 4. View Patch Hunks Only | PASS | Run with the patch file as the active editor and no argument, as from the Command Palette: the same `r1`, partial context, the four files, one reviewed, and one review listed. Its tab read `remote-check.patch [Patch 1: partial context] (4 files)` |
| 5. Close | PASS | Closing that tab released the review; the patch file's tab stayed open |
| After | PASS | No `git status` output; `count: 0`, `in-pack: 581`; refs unchanged; only `config` changed (`branch.main.vscode-merge-base`) |

```text
2026-11-26 13:03:51.762 [info] remote-check.patch: commit eabcdbec06950075f15d24526eb1b7041c7e886d; repositories: <scratch>/vp-check-a
2026-11-26 13:03:52.587 [info] remote-check.patch: complete review r1; base eabcdbec06950075f15d24526eb1b7041c7e886d^.
2026-11-26 13:03:53.568 [info] remote-check.patch: complete review r1; base eabcdbec06950075f15d24526eb1b7041c7e886d^.
2026-11-26 13:03:54.020 [info] remote-check.patch: partial review r1; base (hunks only).
```

A remote window differs from the substitute only in that the extension host runs in the VS Code Server, the editor
runs on another machine, and `vscode.env.remoteName` is set; the window above covered those.

**Check B steps 6 and 7: PASS.** They ran in the operator's signed-in vscode.dev session, Visual Studio Code
1.148.0. The identity gate showed `View Patch 0.3.8`, `Editor: Visual Studio Code 1.148.0 (vscode.dev)`,
`Remote: (none)`, `Platform: browser (no Node.js)`, and `Git version: unavailable: VS Code for the Web cannot run
Git.`

| Step | Result | Observation |
| --- | --- | --- |
| 6. GitHub patch | PASS | **Open Patch as Changes** went straight to hunks only, with no Git warning |
| 7. Reload and reopen | PASS | After marking `CMakeLists.txt` and reloading, **Reopen Recent Patch...** reopened the review with it still reviewed, as the operator reported |

The **View Patch** output from step 6, in the browser's local time, one hour ahead of the times above:

```text
2026-11-26 14:09:52.406 [info] 0001-no-version-script-on-ohos.patch: VS Code for the Web cannot run Git. Showing the patch's hunks only.
2026-11-26 14:09:52.657 [info] 0001-no-version-script-on-ohos.patch: partial review r1; base (hunks only).
```

Not run before the tag, by the operator's choice, from the extra checks in [RELEASING.md](RELEASING.md#pre-releases)
and the list above:

- The screen-reader check. The editor and web tests assert the labels, and check B step 5 read them back, but no
  screen reader spoke them.
- The **Summary** page digests of Publish run `45571963415`. Instead, the Marketplace 0.3.8 package's 25 files
  equal packages built from both `67233b9` and `429fb68`.
- The title in a local window. CI checks its form, `v<version> · local Windows`, in the editor tests on Windows.

### Release and exit verification: 0.3.9, 2026-11-26 (PASS)

Before the tag, the section 8 diff gate ran on the release commit `889b167dfd1f1a18a850c8af985f4ffd89a2a18f` with
`tested=429fb68`: its `--stat` listed only `package.json` and `package-lock.json`, and the `package.json` diff
changed only the `version` line.

Times are Coordinated Universal Time.

| Step | Result | Evidence |
| --- | --- | --- |
| Force push of `main` from `67233b9` to `889b167`, at about 20:15 | GitHub `main` at `889b167`, with the rewritten history; tags `v0.3.5` and `v0.3.7` at their rewritten commits `dbed665` and `5c857d3`; no Publish run started when the tags moved | The repository and its run list |
| CI, CodeQL, and Quality dashboard on `889b167` | Passed by 20:21:07, before the tag was pushed | Runs `45889658323`, `45889658457`, and `45890367954` |
| Tag `v0.3.9` | Points at commit `889b167dfd1f1a18a850c8af985f4ffd89a2a18f`; seen at 21:35:20 | The tag ref |
| Publish run `45899132142`, started by the tag at 21:35:02 | Every job passed except Open VSX, which was skipped; its verify job ran CI on the tagged commit | The job listing |
| Publish job `140182057621` | Its digest, `2f240c662445a8b5d9e5b428bf4fbdd62ebe1a62b5c89a1112f30b6f58c1e46d`, is the one the release notes name. Packaging job `140181671746`'s log was not read: it needs a GitHub sign-in | The release notes |
| GitHub release `v0.3.9` | Regular, not a draft, published 21:40:15. Its `view-patch.vsix` is 145,681 bytes, with digest `sha256:2f240c66…c1e46d`, and its notes are the changelog section with that digest | The release |
| Section 9 commands with `version=0.3.9`, at about 21:45 | Both downloads gave `2f240c662445a8b5d9e5b428bf4fbdd62ebe1a62b5c89a1112f30b6f58c1e46d`, the manifest reads `Version="0.3.9"`, and the pre-release property count printed `0` | Command output |
| Listing | At 21:44:39, `0.3.9` was listed as a regular version, last updated 21:44:21.687, and was the newest version | A listing query |
| Shipped code | The Marketplace 0.3.9 package differs from the 0.3.8 package only in `changelog.md`, the `package.json` version line, and the manifest's version and pre-release property; the 13 files under `extension/out` and `extension/dist` are identical | A file-by-file comparison of the two downloads |

Verdict: PASS. The publish job's digest, the Marketplace download, and the GitHub release asset are equal, and
the Marketplace version carries no pre-release property. The tag was on the release commit, whose only change to
shipped files from the tested `429fb68` is its version.

## 13. Update history

### 2026-11-11 - Initial record

- Written for the 0.3.4 campaign: the manual checks pending, the tag path never yet used.

### 2026-11-11 - Review correction

- Withdrawn: the target of regular 0.3.4 from pre-release 0.3.3. It appeared in the status block ("IN PROGRESS
  for 0.3.4: the manual checks have not been run yet."), section 3, section 8's commands (a diff against
  `8dc16e1` and the tag `v0.3.4`), section 9's `version=0.3.4`, and section 11's row. Attempt 1 (section 12) found
  two web defects. Their fix, `efe7f82`, changes shipped code, so it ships as pre-release 0.3.4, and the regular
  release becomes 0.3.5. Section 12 keeps the attempt-1 identities.
- Withdrawn: section 7 step 4's expected result, which read "Expected: a prompt offering **View Hunks Only**,
  because the browser has no Git. Choose it. Expected: a review listing `hello.txt`, not `i/hello.txt`." From
  0.3.4 the review opens hunk-only without that prompt.
- Narrowed: section 5's vscode.dev `Git version:` row read `unavailable: …`, so finding 1's misleading reason
  passed it. It now requires the exact text, and a wrong reason with the right version is a FAIL, not INVALID.
  Section 5's first-line row now names the section 3 version instead of `View Patch 0.3.3`.
- Added: a section 4 stop rule for an unpushed source commit; section 10 rows for both web defects and for an older
  pre-release; and the web prompt and diagnostics reason as section 2 falsifiers.
- Changed: section 8's diff gate takes the tested commit from a `tested` variable.
- Overturned by: the attempt-1 diagnostics and output in section 12, and the three web tests in
  [`src/test/web/suite.test.ts`](src/test/web/suite.test.ts) that fail against 0.3.3 and pass at `efe7f82`.

### 2026-11-11 - 0.3.4 published

- Recorded pre-release 0.3.4's identities in section 3 and its publication in section 12, attempt 2.
- Changed: section 3's source commit read `a42956a38c8c220bffeaa411c3de7dff2aeb9a3a` (Release 0.3.4), "Local when
  written". It now names `11d4838`, the commit the Publish run built, which differs from `a42956a` only in this
  file. Section 8's `tested` follows it.
- Added: section 6's preconditions for an unshared clone and a new window, with the clone commands; a section 10
  row for a GitHub incident; and a note in attempt 1 on why check A on 0.3.3 has no result.
- Spelled out CI and SHA-256 at first use.

### 2026-11-11 - Check B step 5 correction

- Withdrawn: section 7 step 5, which read "Mark `hello.txt` reviewed, reload the page, and run **View Patch:
  Reopen Recent Patch...**. Expected: the review reopens with the checkmark kept." View Patch never saves a review
  whose source is an unsaved document (`rememberReview` in [`src/controller.ts`](src/controller.ts) skips
  `untitled` sources), and clipboard and sample patches open that way. The step would have failed against
  intended behavior. The correction was made before attempt 2 reached step 5, so no run used the old expectation.
- Added: steps 6 and 7, which test saving with a file-backed patch from GitHub; step 8, which repeats step 4 on a
  reloaded page; one reloaded tab in step 1; and copying the **View Patch** output before reloading when a result
  differs.

### 2026-11-11 - Checks passed on 0.3.4

- Recorded checks A and B on 0.3.4 in section 12, attempt 2, including the unplaced report in check B step 4, and
  filled in section 11's check columns.

### 2026-11-11 - 0.3.5 released

- Recorded the release and its exit verification in section 12, filled in section 11's 0.3.5 row and section 3's
  release row, and set the status to COMPLETE with the verdict PASS.
- Added a dated note to section 12 that the tag path and the GitHub release download first ran for 0.3.5. The
  earlier sentence saying they had not run is kept as written.

### 2026-11-11 - Run 7's cancellation explained

- Section 12, attempt 2: the operator reported cancelling run 7's first attempt by mistake. That attempt published
  nothing, and attempt 2 reran all jobs with the same inputs.

### 2026-11-24 - 0.3.7 campaign

- Retargeted to regular 0.3.7 from pre-release 0.3.6: the status block, section 3, section 8's `tested` and tag,
  and section 9's `version`. Section 3's 0.3.5 identities moved to section 12.
- Changed: section 8 makes the release commit on the tested source commit, tags that commit, and merges it into
  `main` when `main` has moved on. Its commands diffed `HEAD`, then ran `git push origin main`, `git tag v0.3.5`,
  and `git push origin v0.3.5`, which tag the tip of `main`. For 0.3.7 that tip carries the `@vscode/vsce` update
  from Dependabot pull request #2, which the diff gate would list.
- Withdrawn: section 6 step 2's "with a base starting `0aef85b`". The review shows the base as
  `ad2e6ec6e549fae93d5855921b761ae19538f95c^`, as attempt 2 logged on 0.3.4.
- Withdrawn: section 6 step 4's "Expected: a second review of the same four files, labeled partial context."
  Opening a patch again reuses its review and tab (`loadWithProgress` in [`src/controller.ts`](src/controller.ts)
  finds it by its source), so the review switches to hunks. 0.3.4 behaved the same: attempt 2 logged both its
  refreshed and its hunk-only review as `r2`. Step 5 now closes that one review.
- Narrowed: section 7 step 6 called the vcpkg patch "a real patch written with `i/` and `w/`", said to sign in to
  GitHub "if asked", and expected `CMakeLists.txt`, "not `i/CMakeLists.txt`". Upstream now writes the patch with
  `a/` and `b/`, and vscode.dev asks for a sign-in even for a public repository. The step now tests a file-backed
  GitHub patch; step 4 still tests `i/` and `w/`.
- Recorded the checks on 0.3.6 in section 12.

### 2026-11-24 - Checks run as written

- Recorded check A in a Remote - SSH window and check B's steps 6 and 7 in a signed-in vscode.dev session, both on
  0.3.6, in section 12. The record of the substitute runs is kept as written.
- Changed: section 5 and section 10's first row named `0.3.0` as the version showing that the regular channel is
  installed, which stopped being the newest regular version when 0.3.5 shipped. They now point to section 11's
  last row.
- Added: a section 10 row, and a sentence in section 5, for an install with auto update off, which stays on its
  version. Check A met one: the remote install had stayed on 0.3.5.

### 2026-11-24 - 0.3.7 released

- Recorded the release and its exit verification in section 12, filled in section 11's 0.3.7 row and section 3's
  release row, and set the status to COMPLETE with the verdict PASS.

### 2026-11-26 - 0.3.9 campaign

- Retargeted to regular 0.3.9 from pre-release 0.3.8: the status block, section 3, section 8's `tested`, commands,
  and tag, and section 9's `version`. Section 3's 0.3.7 identities moved to section 12.
- Changed: section 8's commands merged the release commit into `main`, as 0.3.7 needed. `main` is still at 0.3.8's
  source commit, so they now fast-forward it; the text still describes the merge for a `main` that has moved on.
- Recorded the evidence for 0.3.8's publication, and the checks run on it so far, in section 12.

### 2026-11-26 - History rewritten

- Removed from every commit on `main`, from tags `v0.3.5` and `v0.3.7`, and from the local branches: a
  `Co-authored-by` trailer, from 54 commit messages. Four passages in this file about who ran the 0.3.6 checks
  were reworded to describe automated runs. Author and committer names, emails, and dates are unchanged.
- Every commit hash changed. Of the 61 rewritten commits, 54 keep identical files and 7 differ only in this file's
  wording, and commit messages name the rewritten hashes. On GitHub, Dependabot's two pull request refs keep the
  34 original commits up to `837e133` reachable; the 25 later ones may stop resolving once GitHub prunes
  unreachable objects.
- Sections 3, 6, and 8 now use the rewritten hashes, and section 8 adds the lease-protected force push of `main`
  and the two tags. Sections 11 and 12, and the entries above, keep the hashes that Actions built and the
  Marketplace published. The table maps each commit this file or RELEASING.md names.
- Added: section 4's exception for a rewrite that keeps every shipped file. A pre-release package built from
  `429fb68`, the rewritten 0.3.8 source commit, equals the Marketplace 0.3.8 package in all 25 files.

| Before | After | Commit |
| --- | --- | --- |
| `1f89c6c` | `6d3bffa` | Add review power, resilience, and web groundwork for 0.3.0 |
| `f60d720` | `0b1c149` | Produce diagnostics on the web instead of failing |
| `0aef85b` | `d5d2748` | Publish the first Open VSX version with a token before trusting the workflow |
| `ad2e6ec` | `eabcdbe` | Read Git's mnemonic path prefixes in hunk-only views |
| `8dc16e1` | `fda3403` | Release 0.3.3 |
| `efe7f82` | `94afd76` | Open web reviews hunk-only and say why |
| `a42956a` | `432b1c6` | Release 0.3.4 |
| `11d4838` | `53994b7` | Retarget the release runbook to 0.3.5 |
| `82110ca` | `dbed665` | Release 0.3.5 |
| `837e133` | `c52dcb4` | Record why run 7's first attempt was cancelled |
| `6f0f88b` | `9726830` | Prepare View Patch 0.3.6 pre-release |
| `3908c05` | `0a6c8ec` | Merge pull request #2 from waddahmoghram/dependabot/npm_and_yarn/development-tools-34904b8917 |
| `934cf27` | `49b039c` | Fix dashboard metrics artifact upload |
| `658e11e` | `5c857d3` | Release 0.3.7 |
| `745f94a` | `c2a3219` | Merge release 0.3.7 into main |
| `67233b9` | `429fb68` | Fix 0.3.8 view title, spoken labels, and mode switching |

### 2026-11-26 - 0.3.9 released

- Recorded checks A and B as written on 0.3.8 in section 12, including check A's steps 3 and 4 in a substitute,
  and the extra checks not run before the tag: the screen reader, the 0.3.8 job digests, and a local window's
  title.
- Recorded the release and its exit verification in section 12, filled in section 11's 0.3.9 row and section 3's
  release row, and set the status to COMPLETE with the verdict PASS.

### 2026-11-26 - Release checks automated

- Added the Release checks workflow and the scripts in `scripts/release-checks/`. After each successful Publish
  run, it runs the exit verification (section 9), check A in a local test instance on Linux and Windows and, once
  the owner accepts its licenses, in a Remote - SSH window (section 6), and check B on public vscode.dev, with steps
  6 and 7 as written once a signed-in session is stored (section 7). Section 10 adds their failure rows, and
  RELEASING.md their one-time setup.
- Changed: section 2's PASS rule now takes their results step by step. A step reported as PASS counts as run as
  written; a substitute counts only where its section says so, which is check A's steps 3, 3a, 4, and 5a from the
  local test instance. Check B's file-backed substitute for steps 6 and 7 does not count.
- Run against the published 0.3.9 before this change was committed: the exit verification of Publish run
  `45899132142` without a token (INCOMPLETE as designed: five digests agree, and the job digests were not read);
  check A in a local test instance on Linux (PASS, 8 steps through a substitute); the Remote - SSH dry run with a
  throwaway SSH server (INCOMPLETE as designed: every step that needs a license not run); and check B (PASS, 2
  steps through a substitute), plus each script's failure paths.
- Not run yet: the workflow on GitHub, check A on Windows, check A in a Remote - SSH window, and check B or the
  sign-in helper with a real GitHub sign-in.
