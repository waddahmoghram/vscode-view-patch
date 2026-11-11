# View Patch validation test plan

## Purpose and scope

This plan states what can go wrong in View Patch, which automated tests guard against each risk, what is still
checked by hand, and when a build may be released. It is derived from the test sources and the workflows in this
repository and cites them rather than restating them.

In scope: the extension in Visual Studio Code (VS Code) desktop, including remote windows, and in VS Code for the
Web; its use of Git; and the packaging and publishing workflows. Out of scope: correctness of Git itself, VS Code's
diff editor rendering, and the registries' own behavior.

## Product risks

| Risk | What could go wrong |
| ---- | ------------------- |
| R1 | Wrong repository or base: a complete-file review applies the patch somewhere it does not belong and shows plausible but wrong content. |
| R2 | Writing to the user's repository: a review changes the working tree, index, references, or Git object store, or fetches missing objects. |
| R3 | Document and tab lifetime: review content leaks after its tabs close, disappears while a tab still shows it, or closing a review closes unrelated editors. |
| R4 | Path identity: patch addresses from remote hosts or file system providers are treated as local paths, or names with spaces, `#`, or characters outside the American Standard Code for Information Interchange (ASCII) break. |
| R5 | Web host without Node.js or Git: the browser bundle needs Node.js built-ins, or Git-backed commands crash instead of declining. |
| R6 | Restricted Mode: Git runs in an untrusted workspace, or hunk-only reviews stop working there. |
| R7 | Parser rejection quality: malformed patches are accepted, silently repaired, or rejected with a vague reason; unsupported mail encodings are guessed at. |
| R8 | Unbounded work: Git runs without time, output, or memory limits, or cancellation leaves processes or scratch files behind. |
| R9 | Content fidelity: equal-size binary changes look identical, or text encodings or line endings are altered. |
| R10 | Review state: a reviewed checkmark survives a change it no longer describes, or a refresh silently replaces the snapshot under review. |
| R11 | Series and merges: dependent patches are applied out of order, or a merge's combined diff is applied as text. |
| R12 | Oldest supported editor: the extension relies on behavior newer than `engines.vscode` (`^1.90.0`) allows. |
| R13 | Release integrity: the published package differs from the one that passed the tests, ships on the wrong channel, or carries a known-vulnerable dependency. |

## Test layers and environments

The continuous integration (CI) workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on each push
to `main` and each pull request, with Node.js 24. Its `test` job is a matrix with `fail-fast: false`: Linux, macOS,
and Windows on the latest stable VS Code, plus Linux on VS Code 1.90.0, the oldest version `package.json` allows.
Each leg compiles both bundles, runs the unit tests, and runs the editor and Restricted Mode tests, under
`xvfb-run` on Linux.

| Layer | What runs | Where |
| ----- | --------- | ----- |
| Unit | `node:test` over `out/test/unit`, with real Git in temporary repositories. [`src/test/helpers.ts`](src/test/helpers.ts) isolates the machine's Git configuration and identity. | Every matrix leg; the Linux stable leg also writes a coverage report. |
| Editor integration | Mocha inside a real VS Code through `@vscode/test-cli` ([`.vscode-test.mjs`](.vscode-test.mjs)): an empty window, other extensions disabled, workspace trust bypassed, and a separate profile per VS Code version. | Every matrix leg, so on stable and on 1.90.0. |
| Restricted Mode | [`scripts/test-restricted.mjs`](scripts/test-restricted.mjs) launches an isolated VS Code with workspace trust enabled, Git disabled, and a fresh profile, then runs [`src/test/restricted/run.ts`](src/test/restricted/run.ts). | Every matrix leg. |
| Web extension host | [`scripts/test-web.mjs`](scripts/test-web.mjs) runs the suite in VS Code for the Web on headless Chromium through `@vscode/test-web`, loading the production bundle `dist/web/extension.js`. | `test-web` job: Linux, after the matrix passes. |
| Packaging gate | `npm audit --include=dev`, then `vsce package` (with `--pre-release` when the Publish workflow asks); the package's SHA-256 (Secure Hash Algorithm, 256-bit) digest is recorded and the file is uploaded as the `view-patch-vsix` artifact. | `package` job: Linux, after the matrix passes. |
| Publish gates | [`.github/workflows/publish.yml`](.github/workflows/publish.yml), described below. | Tag pushes and manual runs from `main`. |
| Inventory drift | `node scripts/test-inventory.mjs --check`, described in [Test inventory](#test-inventory). | Linux stable leg. |
| Static analysis | CodeQL `security-and-quality` queries for JavaScript and TypeScript ([`.github/workflows/codeql.yml`](.github/workflows/codeql.yml)). Not a release gate. | Pushes and pull requests to `main`, and weekly. |
| Quality dashboard | [`scripts/quality-dashboard.mjs`](scripts/quality-dashboard.mjs), run by [`.github/workflows/dashboard.yml`](.github/workflows/dashboard.yml), reports release-readiness rules, workflow history, test counts from CI logs, digest agreement, and registry listings. A monitor, not a gate; see [Quality dashboard](RELEASING.md#quality-dashboard). | Daily, by hand, and after CI or Publish runs on `main` or a release tag. |

The Publish workflow first calls CI as its `verify` job, so a release waits for every matrix leg, the web tests,
the audit, and packaging. Its `publish` job then checks that a release tag matches the `package.json` version,
downloads the exact package CI built instead of rebuilding it, checks that the package's pre-release flag matches
the requested channel, records the digest, publishes with Trusted Publishing, and for a tag attaches the same file
to a GitHub release. A separate `open-vsx` job, which runs only when the repository variable `OPEN_VSX_PUBLISHING`
is `trusted` or `token`, downloads the same package, records its digest, and publishes it to Open VSX. Comparing
the recorded digests shows whether each registry received the tested file. Concurrent publishing runs are
serialized.

## Traceability

Each row names the files that guard a risk and representative tests from them, quoted exactly. The check in
[Test inventory](#test-inventory) fails when a quoted title no longer exists in the files of its row.

<!-- traceability:begin -->

| Risk | Layer | Test files | Representative tests |
| ---- | ----- | ---------- | -------------------- |
| R1 | unit | [`src/test/unit/repositories.test.ts`](src/test/unit/repositories.test.ts) | "uses the repository that has the patch commit, on that commit's parent"; "tries HEAD in every repository when the patch names no commit"; "returns every repository where the patch applies"; "surfaces repository failures instead of reporting a patch mismatch" |
| R1 | unit | [`src/test/unit/patch.test.ts`](src/test/unit/patch.test.ts) | "reads the commit from the first line of a git format-patch file"; "does not treat a cover letter hash as a commit"; "freezes the tree before a moving HEAD can change later snapshots" |
| R1 | editor | [`src/test/integration/noWorkspace.test.ts`](src/test/integration/noWorkspace.test.ts), [`src/test/integration/features.test.ts`](src/test/integration/features.test.ts), [`src/test/integration/extension.test.ts`](src/test/integration/extension.test.ts) | "finds the repository through the patch file's own folder"; "declines an already-applied plain diff without opening a wrong review"; "opens nothing for an inapplicable patch until a fallback is explicitly selected" |
| R2 | unit | [`src/test/unit/patch.test.ts`](src/test/unit/patch.test.ts) | "never writes to the repository and removes its scratch folder"; "does not freshen packed source objects when the applied result already exists there"; "preserves dirty linked worktrees, split indexes, ignored files, refs, and source objects" |
| R2 | unit | [`src/test/unit/series.test.ts`](src/test/unit/series.test.ts), [`src/test/unit/commitReview.test.ts`](src/test/unit/commitReview.test.ts), [`src/test/unit/interdiff.test.ts`](src/test/unit/interdiff.test.ts), [`src/test/unit/repositories.test.ts`](src/test/unit/repositories.test.ts) | "stores intermediate trees and previously absent blobs only in one private object database"; "runs no writing command on a packed-and-loose source and leaves it untouched"; "never writes to the source repository and removes its scratch folder"; "blocks even local remote transports" |
| R3 | editor | [`src/test/integration/documents.test.ts`](src/test/integration/documents.test.ts) | "keeps content for more than twenty views until explicitly released"; "retains a removed path while its individual document remains open" |
| R3 | editor | [`src/test/integration/extension.test.ts`](src/test/integration/extension.test.ts) | "retains more than twenty open reviews without losing earlier content"; "retains a review while an individual file diff remains open"; "closing a review does not close an unrelated editor"; "reuses the review and tab when the same patch is opened again" |
| R4 | editor | [`src/test/integration/extension.test.ts`](src/test/integration/extension.test.ts), [`src/test/integration/documents.test.ts`](src/test/integration/documents.test.ts) | "reads provider-backed patch addresses without treating them as local file paths"; "keeps spaces, non-ASCII names, and reserved address characters in source paths"; "serves absolute paths from plain unified patches without an invalid double-slash address" |
| R4 | unit | [`src/test/unit/patchText.test.ts`](src/test/unit/patchText.test.ts), [`src/test/unit/combined.test.ts`](src/test/unit/combined.test.ts) | "strips each prefix pair Git writes with diff.mnemonicPrefix, including names with spaces"; "reads a mnemonic header alone when a change has no --- and +++ lines"; "keeps a shared one-letter directory, as in --no-prefix output, instead of treating it as a pair"; "strips the i/ and w/ prefixes of a conflict diff written with diff.mnemonicPrefix" |
| R5 | unit | [`src/test/unit/webBundle.test.ts`](src/test/unit/webBundle.test.ts) | "web bundle builds, contains no Node built-in requires, and loads without Buffer or process"; "sha256 shim matches node:crypto on all block boundaries and a large input" |
| R5 | web | [`src/test/web/suite.test.ts`](src/test/web/suite.test.ts) | "openHunks on untitled diff text shows one partial review with readable sides"; "opening a patch on the web goes straight to hunks, because the web host cannot run Git"; "reviewing a commit on the web declines with the reason instead of attempting Git"; "diagnostics are produced without Node globals, for bug reports from the web" |
| R6 | restricted | [`src/test/restricted/run.ts`](src/test/restricted/run.ts) | "real Restricted Mode blocks Git-backed viewing and permits explicit hunk-only reviews." |
| R6 | editor | [`src/test/integration/noWorkspace.test.ts`](src/test/integration/noWorkspace.test.ts), [`src/test/integration/extension.test.ts`](src/test/integration/extension.test.ts) | "opens explicitly partial hunks with no repository anywhere"; "shows explicit partial context without needing the patch repository" |
| R7 | unit | [`src/test/unit/patchText.test.ts`](src/test/unit/patchText.test.ts) | "rejects ${name} explicitly", 35 table-driven cases that include a context line that lost its leading space and hunk counts smaller than the body; "rejects empty or ordinary text instead of returning success-shaped empty parts"; "flags an unrecognized transfer encoding per message instead of guessing" |
| R7 | unit | [`src/test/unit/combined.test.ts`](src/test/unit/combined.test.ts), [`src/test/unit/patch.test.ts`](src/test/unit/patch.test.ts) | "rejects inputs with no combined diffs instead of returning empty success"; "reports why a patch does not apply" |
| R7 | editor | [`src/test/integration/extension.test.ts`](src/test/integration/extension.test.ts), [`src/test/integration/features.test.ts`](src/test/integration/features.test.ts) | "opens nothing for a file that is not a patch"; "declines clipboard text that is not a patch" |
| R8 | unit | [`src/test/unit/git.test.ts`](src/test/unit/git.test.ts), [`src/test/unit/patch.test.ts`](src/test/unit/patch.test.ts) | "times out and reaps the child before rejecting"; "cancels a running child, escalates, and waits for close"; "terminates an unbounded stderr producer at the combined output cap"; "cleans its private index and objects when cancelled between phases" |
| R8 | editor | [`src/test/integration/documents.test.ts`](src/test/integration/documents.test.ts) | "accepts the exact memory bound and rejects one byte more without changing old views" |
| R9 | editor | [`src/test/integration/documents.test.ts`](src/test/integration/documents.test.ts), [`src/test/integration/extension.test.ts`](src/test/integration/extension.test.ts) | "distinguishes binary files of equal size by content fingerprint"; "decodes supported byte-order marks without replacement characters"; "displays equal-size binary changes truthfully in the actual Changes documents" |
| R9 | unit | [`src/test/unit/patchText.test.ts`](src/test/unit/patchText.test.ts) | "preserves observed carriage-return/newline line endings in hunk content"; "decodes quoted-printable byte-exactly and keeps invalid escapes literal" |
| R10 | editor | [`src/test/integration/extension.test.ts`](src/test/integration/extension.test.ts), [`src/test/integration/features.test.ts`](src/test/integration/features.test.ts), [`src/test/integration/documents.test.ts`](src/test/integration/documents.test.ts) | "refreshes one review, retaining only unchanged reviewed checkmarks"; "offers refresh on save without silently replacing the reviewed snapshot"; "flags an externally regenerated source patch without replacing the snapshot"; "retains review flags only when the exact change remains unchanged" |
| R11 | unit | [`src/test/unit/series.test.ts`](src/test/unit/series.test.ts), [`src/test/unit/seriesInput.test.ts`](src/test/unit/seriesInput.test.ts), [`src/test/unit/merge.test.ts`](src/test/unit/merge.test.ts) | "applies two dependent messages and keeps cumulative and per-message versions"; "identifies a failing later message and never attempts its successor"; "rejects duplicate numbers rather than choosing an ambiguous order"; "loads what a two-parent merge changed against each parent" |
| R11 | editor | [`src/test/integration/features.test.ts`](src/test/integration/features.test.ts) | "shows a merge commit as real per-parent changes when its repository is known"; "shows per-parent hunk views for a combined diff whose repository is unknown" |
| R12 | all desktop layers | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | The `vscode: 1.90.0` matrix leg repeats the unit, editor, and Restricted Mode suites on the oldest supported VS Code. |
| R13 | packaging gate | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Steps **Audit dependency vulnerabilities**, **Package**, and **Record the package digest** in the `package` job. |
| R13 | publish gates | [`.github/workflows/publish.yml`](.github/workflows/publish.yml) | Steps **Check that the tag matches package.json**, **Download the package that CI verified**, and **Check the package's channel and record its digest** in `publish`; **Record the package digest** in `open-vsx`. |
| R13 | unit | [`src/test/unit/qualityDashboard.test.ts`](src/test/unit/qualityDashboard.test.ts) | "matches digests from every job and the Marketplace download of the published version"; "reports a mismatch for a differing digest or channel"; "reports not recorded or unavailable instead of claiming a match" |

<!-- traceability:end -->

The command-level editor suites in `extension.test.ts`, `features.test.ts`, and `noWorkspace.test.ts`, and the web
suite, also end every test by closing all editors and waiting until the extension holds no review content, so
each of those tests checks R3 as a side effect.

## Test inventory

[`scripts/test-inventory.mjs`](scripts/test-inventory.mjs) counts the tests each layer defines by scanning the
sources, without running them, and its own tests are in
[`src/test/unit/testInventory.test.ts`](src/test/unit/testInventory.test.ts). `--list` prints every title. The CI
step running it with `--check` fails when the counts below or the quoted titles in [Traceability](#traceability)
disagree with the sources; update this plan in the same change as the tests.

<!-- test-inventory:begin -->

| Layer      | Runner                                         | Test sources                        | Count |
| ---------- | ---------------------------------------------- | ----------------------------------- | ----: |
| unit       | `node:test`, `npm run test:unit`               | `src/test/unit/**/*.test.ts`        |   362 |
| editor     | Mocha in VS Code, `npm run test:editor`        | `src/test/integration/**/*.test.ts` |    56 |
| restricted | Isolated VS Code, `npm run test:restricted`    | `src/test/restricted/run.ts`        |     1 |
| web        | Mocha in headless Chromium, `npm run test:web` | `src/test/web/suite.test.ts`        |     6 |

<!-- test-inventory:end -->

These counts equal the runners' own totals, the `ℹ tests` line from `node:test` and the `passing` lines from
Mocha. Parameterized tests are why a naive search for `test(` finds fewer: unit tests defined in loops of the form
`for (const x of [...])` run once per array element, so the scan counts them that way, and `--list` marks them
with `[xN]`. It reports a test it cannot count exactly, such as one inside a helper function or a conditional, as
a problem rather than guessing. The restricted layer is one scripted session rather than a Mocha suite, so it
counts the scenarios that print a `PASS:` line. Skipped tests would still be counted here, while runners report
them separately; there are none. CI runs the unit, editor, and Restricted Mode layers once per matrix leg, and the
Linux stable leg runs the unit tests twice, once for coverage.

## Manual checks and known gaps

Not automated:

- A real remote window, such as one over Secure Shell (SSH): a complete-file review, a hunk-only review, refresh,
  and closing the last tab. The provider-backed address test covers path handling with a stand-in file system,
  not a remote extension host.
- A public vscode.dev session with the extension installed from the Marketplace: hunk-only reviews from the
  clipboard and from a patch file in a GitHub repository, and a saved review reopened after a reload. The web tests
  load the development folder into a local VS Code for the Web server instead.
- The Open VSX listing after an Open VSX publish. The quality dashboard reports the listed version, channel, and
  whether the namespace is verified, but nothing fails when they are wrong.
- Visual rendering. The tests check document contents and extension state, not how VS Code draws the diff.

[RELEASING.md](RELEASING.md#checking-a-package-locally) asks for the first two before each regular release; the
[regular release runbook](RELEASE_RUNBOOK.md) gives their steps, decision rules, and results.

Known defects:

- Fixed in 0.3.3, found 2026-11-10: the hunk-only parser in [`src/patchText.ts`](src/patchText.ts) stripped only
  `a/` and `b/` path prefixes, so patches written with Git's `diff.mnemonicPrefix` setting (`i/`, `w/`, `c/`,
  `o/`, and `--no-index`'s `1/` and `2/`) displayed as `i/file` → `w/file`, and a header-only change to a name
  with spaces split at the first space. The R4 unit tests above now cover each pair Git 2.34.1 was observed to
  write, merge-conflict diffs, and a shared one-letter directory that must keep its name.
- Fixed in 0.3.4, found 2026-11-11 by the first manual vscode.dev check of 0.3.3: opening a patch in VS Code for
  the Web showed an error blaming a missing repository and offered **Choose Repository and Base...**, though a
  browser can never run Git, and **Copy Diagnostics** gave a misleading home-folder reason for the missing Git
  version. Web reviews now open hunk-only with a one-time explanation, **Review a Commit** declines with the reason,
  and the diagnostics name it. The three R5 web tests that cover this failed against 0.3.3.
- Fixed in f60d720: **Copy Diagnostics** failed in VS Code for the Web because it read Node.js process details.
  The web test "diagnostics are produced without Node globals, for bug reports from the web" now covers it,
  alongside the desktop editor test "copies diagnostics that identify the install without running a review".

## Release entry and exit criteria

[RELEASING.md](RELEASING.md) is the procedure; this section only names the gates.

- Entry: CI is green on `main` for the release commit, including every matrix leg, the web tests, the dependency
  audit, packaging, and the inventory check; the version and `CHANGELOG.md` are updated as
  [Each release](RELEASING.md#each-release) describes; for a regular release, the manual checks above are done.
- Exit: the Publish run succeeded; the digests recorded by the packaging job and by each publishing job are equal;
  the Marketplace lists the new version on the intended channel; and when Open VSX publishing is enabled, its job
  succeeded too. The quality dashboard re-checks the digests after each Publish run, adding the Marketplace's own
  digest of the version that run published.

## Running each layer

From a clean checkout, with Git on `PATH`. On Linux without a display, prefix the editor, Restricted Mode, and web
commands with `xvfb-run -a`.

```bash
npm ci
npm run compile
npm run compile:web
npm run test:unit
npm run test:unit:coverage
npm run test:editor
VSCODE_TEST_VERSION=1.90.0 npm run test:editor
npm run test:restricted
npm run test:web
node scripts/test-inventory.mjs --check
```

`npm test` compiles and then runs the unit, editor, and Restricted Mode layers. Options after
`npm run test:web --` reach the web runner: `--quality insiders`, `--headed`, `--verbose`, and `--port <n>`; its
first run downloads VS Code for the Web. For the packaging gate, run `npm audit --include=dev`,
`npx vsce package`, and `npx vsce ls`, as in [Checking a package locally](RELEASING.md#checking-a-package-locally).
