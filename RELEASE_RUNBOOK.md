# Regular release runbook

Created 2026-11-11. Use it for every regular (non-pre-release) release. [RELEASING.md](RELEASING.md) is the
general procedure and one-time setup; [TEST_PLAN.md](TEST_PLAN.md) names the automated gates. This runbook adds
the manual checks a regular release needs, the tag-driven publish, and the exit verification, with the decision
rules for each step.

> **Status:** IN PROGRESS for regular 0.3.5. Attempt 1 checked pre-release 0.3.3 and found two web defects
> (section 12); their fix ships as pre-release 0.3.4, and both checks repeat on it.
>
> **Current verdict:** PENDING.
>
> **Controlling correction:** [2026-11-11 review correction](#2026-11-11---review-correction): the release
> target moved from 0.3.4 to 0.3.5.

## 1. Purpose

A regular release is what every user gets from **Install**, so it needs evidence the automated suites cannot
provide: the extension working in a real remote window and on public vscode.dev, installed from the Marketplace.
The question each campaign answers: is the candidate commit safe to publish on the regular channel?

## 2. Validation contract

### Preconditions

- The candidate's code was already published as a pre-release, its Publish run passed, and its packaging,
  publishing, and Marketplace digests matched.
- CI and CodeQL are green on `main` at the commit that pre-release came from.
- The release commit will change only the version, `CHANGELOG.md`, and documentation relative to that commit.

### PASS

- Both manual checks in sections 6 and 7 meet every expected result, with the runtime identity gate passing.
- After tagging, the exit checks in section 9 pass: the CI, publishing, Marketplace, and GitHub release digests are
  equal, and the Marketplace lists the version without the pre-release property.

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
| Release version | `0.3.5` | Higher than the latest pre-release, as [RELEASING.md](RELEASING.md#release-channels) requires |
| Pre-release under test | `0.3.4` | Pending publication; record its Marketplace validation time here |
| Its source commit | `a42956a38c8c220bffeaa411c3de7dff2aeb9a3a` (Release 0.3.4) | Local when written; after the push, `git branch -r --contains a42956a` must list `origin/main` |
| Its package SHA-256 | pending | Record the matching packaging, publishing, and Marketplace digests from its Publish run |
| Remote-check patch | `git format-patch -1 ad2e6ec`, four files, parent `0aef85b` | `git show --stat ad2e6ec` |
| Release commit and tag | pending | Section 8 |

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
repository that contains `ad2e6ec`; View Patch installed on the remote side; the folder trusted.

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
   `src/patchText.ts`, and two unit test files), and **Patch Reviews** showing this clone with a base starting
   `0aef85b`.
3. Mark one file reviewed, then run **View Patch: Refresh Review**. Expected: the review refreshes and the
   checkmark remains.
4. Run **View Patch: View Patch Hunks Only**. Expected: a second review of the same four files, labeled partial
   context.
5. Close each review's last tab. Expected: the review leaves **Patch Reviews**; no unrelated editor closes.

```bash
rm remote-check.patch
git status --short
git count-objects -v | grep -E '^(count|in-pack):'
```

Expected: no `git status` output, and the same two counts as before. Any change is a FAIL: complete-file reviews
must leave the repository unchanged.

## 7. Manual check B: public vscode.dev

1. Open <https://vscode.dev>, install **View Patch** from the Extensions view, then choose **Switch to
   Pre-Release Version**. Expected: no message that it is unavailable in VS Code for the Web.
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
5. Mark `hello.txt` reviewed, reload the page, and run **View Patch: Reopen Recent Patch...**. Expected: the
   review reopens with the checkmark kept.

## 8. Cut the release

The release commit sets `version` in `package.json` and `package-lock.json` to the release version, adds its
`CHANGELOG.md` section, and updates any documentation the checks settled. Then confirm it changes no shipped code
relative to the tested pre-release's source commit from section 3:

```bash
tested=a42956a
git diff --stat "$tested" HEAD -- . ':(exclude)*.md' ':(exclude).github' ':(exclude).vscodeignore'
git diff "$tested" HEAD -- package.json
```

Expected: only `package.json` and `package-lock.json`, and only their version lines. Anything else is INVALID for
this campaign. Then push, wait for CI and CodeQL to pass on that commit, and push the tag:

```bash
git push origin main
git tag v0.3.5
git push origin v0.3.5
```

The tag starts the Publish workflow as a regular release. Its first steps refuse a tag that does not match
`package.json`; that failure happens before anything is uploaded.

## 9. Exit verification

1. In the Publish run, all jobs pass except Open VSX, which is skipped unless enabled.
2. On the run's **Summary** page, `Packaged view-patch.vsix (regular)` and `Publishing view-patch.vsix (regular)`
   show the same SHA-256.
3. After the Marketplace scan, usually under ten minutes, compare the registry and the GitHub release:

```bash
version=0.3.5
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

## 11. Release record

| Version | Channel | Published | Source commit | Check A | Check B | Package SHA-256 (CI = publish = Marketplace) |
| --- | --- | --- | --- | --- | --- | --- |
| 0.3.0 | regular | 2026-11-10 | `1f89c6c` | not recorded | not recorded | not comparable: rebuilt at publish |
| 0.3.5 | regular | pending | pending | pending | pending | pending |

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
GitHub release download still have not run.

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

Verdict: none. The attempt stopped under section 4's second rule: the fix, `efe7f82`, changes shipped code, so it
ships as pre-release 0.3.4 and both checks repeat on it. The three web tests covering the findings fail against
0.3.3 and pass at `efe7f82`.

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
