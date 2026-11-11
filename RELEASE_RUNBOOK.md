# Regular release runbook

Created 2026-11-11. Use it for every regular (non-pre-release) release. [RELEASING.md](RELEASING.md) is the
general procedure and one-time setup; [TEST_PLAN.md](TEST_PLAN.md) names the automated gates. This runbook adds
the manual checks a regular release needs, the tag-driven publish, and the exit verification, with the decision
rules for each step.

> **Status:** IN PROGRESS for 0.3.4: the manual checks have not been run yet.
>
> **Current verdict:** PENDING.

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
  prefixes (section 7), or **Copy Diagnostics** failing on the web disproves readiness.

## 3. Identities for the current campaign

| Item | Value | Evidence |
| --- | --- | --- |
| Release version | `0.3.4` | Higher than the latest pre-release, as [RELEASING.md](RELEASING.md#release-channels) requires |
| Pre-release under test | `0.3.3` | Marketplace, validated 2026-11-11 |
| Its source commit | `8dc16e104aa23b3ee19ac6824bcdb11d302e4947` | `main` after `git push`, 2026-11-11 |
| Its package SHA-256 | `d3bebc93b9a0787708e209caca0584565119b43963ee3fc0cae4e6d41826cfaa` | Packaging job, publish job, and Marketplace download all equal (Publish run 43069223565) |
| Remote-check patch | `git format-patch -1 ad2e6ec`, four files, parent `0aef85b` | `git show --stat ad2e6ec` |
| Release commit and tag | pending | Section 8 |

## 4. Stop rules

- STOP before tagging unless both manual checks passed and section 8's diff gate passed.
- STOP if a check needs a code change: that change must ship as a pre-release first, then the checks repeat.
- A published version can never be withdrawn or reused. A mistake after publishing is fixed forward with the next
  patch version.
- Never paste credentials, tokens, or private patches into these checks. Use the patches named here.

## 5. Runtime identity gate

Run **View Patch: Copy Diagnostics** and paste the result into a new untitled editor. Required:

| Check | Remote window (section 6) | vscode.dev (section 7) |
| --- | --- | --- |
| First line | `View Patch 0.3.3` | `View Patch 0.3.3` |
| `Remote:` | `ssh-remote` or another remote name | `(none)` |
| `Platform:` | the host's operating system and Node.js version | `browser (no Node.js)` |
| `Git version:` | `git version …` | `unavailable: …` |

Any other value makes the check INVALID. A version of `0.3.0` means the regular release is installed: choose
**Switch to Pre-Release Version** in the Extensions view, reload, and run the gate again.

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

   Expected: a prompt offering **View Hunks Only**, because the browser has no Git. Choose it. Expected: a review
   listing `hello.txt`, not `i/hello.txt`.
5. Mark `hello.txt` reviewed, reload the page, and run **View Patch: Reopen Recent Patch...**. Expected: the
   review reopens with the checkmark kept.

## 8. Cut the release

The release commit sets `version` in `package.json` and `package-lock.json` to the release version, adds its
`CHANGELOG.md` section, and updates any documentation the checks settled. Then confirm it changes no shipped code:

```bash
git diff --stat 8dc16e1 HEAD -- . ':(exclude)*.md' ':(exclude).github' ':(exclude).vscodeignore'
git diff 8dc16e1 HEAD -- package.json
```

Expected: only `package.json` and `package-lock.json`, and only their version lines. Anything else is INVALID for
this campaign. Then push, wait for CI and CodeQL to pass on that commit, and push the tag:

```bash
git push origin main
git tag v0.3.4
git push origin v0.3.4
```

The tag starts the Publish workflow as a regular release. Its first steps refuse a tag that does not match
`package.json`; that failure happens before anything is uploaded.

## 9. Exit verification

1. In the Publish run, all jobs pass except Open VSX, which is skipped unless enabled.
2. On the run's **Summary** page, `Packaged view-patch.vsix (regular)` and `Publishing view-patch.vsix (regular)`
   show the same SHA-256.
3. After the Marketplace scan, usually under ten minutes, compare the registry and the GitHub release:

```bash
version=0.3.4
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
| "No Git repository was found" in check A | The patch is outside the clone, or Git is missing | Fix the precondition; the run is INVALID |
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
| 0.3.4 | regular | pending | pending | pending | pending | pending |

Pre-releases need no manual checks; [RELEASING.md](RELEASING.md#release-channels) lists them.

## 12. Commands actually run

On 2026-11-11 the section 9 digest comparison was run for the 0.3.2 and 0.3.3 pre-releases: each Marketplace
download matched its packaging and publishing digests (`96afd402…21bb79` and `d3bebc93…26cfaa`).

The same day, on a Linux clone and without VS Code, these commands were dry-run to confirm they behave as written:

- Section 6 preflight: `check commit present`, and the `ad2e6ec` patch contains four `diff --git` sections.
- Section 8 diff gate: valid syntax; it printed nothing because no release commit existed yet.
- Section 9 Marketplace commands with `version=0.3.3`: digest `d3bebc93…26cfaa`, and the pre-release property count
  printed `1`, as expected for a pre-release.

The manual checks in VS Code, the tag path, and the GitHub release download have not run yet; they stay proposed
until a campaign records them here.

## 13. Update history

### 2026-11-11 - Initial record

- Written for the 0.3.4 campaign: the manual checks pending, the tag path never yet used.
