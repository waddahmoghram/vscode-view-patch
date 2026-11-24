# Regular release runbook

Created 2026-11-11. Use it for every regular (non-pre-release) release. [RELEASING.md](RELEASING.md) is the
general procedure and one-time setup; [TEST_PLAN.md](TEST_PLAN.md) names the automated gates. This runbook adds
the manual checks a regular release needs, the tag-driven publish, and the exit verification, with the decision
rules for each step.

> **Status:** IN PROGRESS for regular 0.3.7 from pre-release 0.3.6. On 2026-11-24 every expected result of both
> checks held, but two runs used substitutes (section 12): check A ran in a `code serve-web` window instead of
> Remote - SSH, and check B's steps 6 and 7 used a saved patch, because vscode.dev now requires a GitHub sign-in.
> Those two runs as written, the tag, and the exit verification are pending. Regular 0.3.5 was published on
> 2026-11-11 (section 12).
>
> **Current verdict:** none yet.
>
> **Controlling corrections:** [2026-11-24 0.3.7 campaign](#2026-11-24---037-campaign): the release commit is
> made on the tested source commit and tagged there, because `main` moved past that commit.
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

- Both manual checks in sections 6 and 7 meet every expected result, with the runtime identity gate passing.
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
| Release version | `0.3.7` | Higher than the latest pre-release, as [RELEASING.md](RELEASING.md#release-channels) requires |
| Pre-release under test | `0.3.6` | Marketplace download, 2026-11-24 |
| Its source commit | `6f0f88b1c3c28ab128e331c78ad48c3abe704060` | The commit Publish run `45348403770` built; CI run `45347481251` and CodeQL run `45347481178` passed on it |
| Its package SHA-256 | `e3d3f4de54507da3b6d9df4cd25d81d1cd34912b99d9cdee92e2e88f0a0ef8ab` | Packaging job `138289840286`, publish job `138290358037`, and the Marketplace download all equal |
| Remote-check patch | `git format-patch -1 ad2e6ec`, four files, parent `0aef85b` | `git show --stat ad2e6ec` |
| Release commit and tag | Pending: a release commit on `6f0f88b`, merged into `main`, with tag `v0.3.7` on the release commit | Section 8 |

## 4. Stop rules

- STOP before tagging unless both manual checks passed and section 8's diff gate passed.
- STOP if a check needs a code change: that change must ship as a pre-release first, then the checks repeat.
- STOP if the section 3 source commit is not on GitHub `main` after the push, for example after a rebase: its
  identities are void until section 3 names the commit the Publish run actually built.
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
`PATH`, and the check is INVALID. A version of `0.3.0` means the regular release is installed: choose
**Switch to Pre-Release Version** in the Extensions view, reload, and run the gate again. An older pre-release
means the new one has not reached this editor yet: update the extension, reload, and run the gate again.

## 6. Manual check A: a real remote window

Preconditions: a VS Code window connected through Remote - SSH to a host with Git on `PATH` and a clone of this
repository that contains `ad2e6ec`; View Patch installed on the remote side; the folder trusted. Two more come from
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
git cat-file -e 'ad2e6ec^{commit}' && echo "check commit present"
git status --short
git count-objects -v | grep -E '^(count|in-pack):'
```

Expected: `check commit present`, no `git status` output, and two counts to compare after the check.

```bash
git format-patch -1 ad2e6ec --stdout > remote-check.patch
code remote-check.patch
```

1. Run the identity gate (section 5).
2. Run **View Patch: Open Patch as Changes**. Expected: one Changes view with four files (`TEST_PLAN.md`,
   `src/patchText.ts`, and two unit test files), and **Patch Reviews** showing this clone with the base
   `ad2e6ec6e549fae93d5855921b761ae19538f95c^`, which is `0aef85b`.
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

## 8. Cut the release

The release commit sets `version` in `package.json` and `package-lock.json` to the release version, adds its
`CHANGELOG.md` section, and updates any documentation the checks settled. Make it on top of the tested
pre-release's source commit from section 3, then confirm it changes no shipped code relative to that commit:

```bash
tested=6f0f88b
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
git merge -m 'Merge release 0.3.7 into main' "$release"
git push origin main
git tag v0.3.7 "$release"
git push origin v0.3.7
```

The tag starts the Publish workflow as a regular release. Its verify job runs CI on the tagged commit, and its
first publish steps refuse a tag that does not match `package.json`; both happen before anything is uploaded.

## 9. Exit verification

1. In the Publish run, all jobs pass except Open VSX, which is skipped unless enabled.
2. On the run's **Summary** page, `Packaged view-patch.vsix (regular)` and `Publishing view-patch.vsix (regular)`
   show the same SHA-256.
3. After the Marketplace scan, usually under ten minutes, compare the registry and the GitHub release:

```bash
version=0.3.7
curl -sL --compressed -o "marketplace-${version}.vsix" \
  "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/waddahmoghram/vsextensions/view-patch/${version}/vspackage"
curl -sL -o "github-${version}.vsix" \
  "https://github.com/waddahmoghram/vscode-view-patch/releases/download/v${version}/view-patch.vsix"
sha256sum "marketplace-${version}.vsix" "github-${version}.vsix"
unzip -p "marketplace-${version}.vsix" extension.vsixmanifest | grep -c 'Code.PreRelease'
```

Expected: both digests equal the Summary digest, and the last command prints `0`: a regular package carries no
pre-release property. Any mismatch: stop announcing the release and investigate the publish path.

## 10. Failure matrix

| Symptom | Meaning | Action |
| --- | --- | --- |
| The identity gate shows `0.3.0` | The regular channel is installed | Switch to the pre-release and rerun the gate |
| The identity gate shows an older pre-release | The new version has not reached this editor | Update the extension, reload, and rerun the gate |
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

## 11. Release record

| Version | Channel | Published | Source commit | Check A | Check B | Package SHA-256 (CI = publish = Marketplace) |
| --- | --- | --- | --- | --- | --- | --- |
| 0.3.0 | regular | 2026-11-10 | `1f89c6c` | not recorded | not recorded | not comparable: rebuilt at publish |
| 0.3.5 | regular | 2026-11-11 | `82110ca` | PASS on 0.3.4, 2026-11-11 | PASS on 0.3.4, 2026-11-11 | `661153806417c5cfc8fe5000a0cc5ee0b5e1a646ae18dd43bf3def316693a3c6`, also equal to the GitHub release asset |

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
