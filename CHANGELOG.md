# Changelog

## Unreleased

- Releases now publish the exact package that continuous integration built and checked, instead of
  rebuilding it at publish time. The publish job confirms the package's pre-release or regular channel
  before uploading, and both jobs record its SHA-256 digest so the two can be compared.

## 0.3.1

- Review a Commit...: review any revision straight from history, no patch file needed - per-parent
  sections for merges, empty-tree base for a root commit, reviewed checkmarks keyed to the commit.
- Open Patch from Clipboard: copied patch text opens directly, without pasting into an editor first.
- Next/Previous Unreviewed File commands walk the remaining checklist, and the optional
  `viewPatch.markReviewedOnOpen` setting checks files off as their diffs are opened.
- Copy Diff for This File: a file entry's change as a valid, applyable unified diff on the clipboard.
- The Markdown review summary adds per-file line counts (+added/-deleted) in complete reviews.
- Hunk-parser rejections now explain the two usual causes inline: a context line that lost its
  leading space, and `@@` header counts smaller than the hunk body.
- A Get Started walkthrough, a sample link in the empty Patch Reviews view, and a README
  troubleshooting section cover the first-contact paths.
- A real headless web session now runs in continuous integration against the browser bundle.
- Dependabot no longer proposes `@types/vscode` bumps (the types floor must equal the oldest
  supported editor; packaging rejects anything newer) or `@types/node` majors.

## 0.3.0

- Explain already-applied patches: when a patch reverse-applies cleanly at `HEAD`, say so instead of
  "does not apply", and still offer the hunk-only view.
- Compare two patch versions: apply both to the same base and review the result difference as its own
  read-only Changes view. Identical results are reported instead of opening an empty review.
- Review merge commits: a combined diff whose commit exists in a known repository opens as real per-parent
  changes from history; without the repository, explicit per-parent hunk views are shown.
- Decode `quoted-printable` and `base64` mail bodies; unsupported encodings and multipart mail are rejected
  with a named reason instead of a confusing Git failure.
- Remember reviews across window reloads: reopening an unchanged patch restores its reviewed checkmarks,
  the previously chosen repository and base are retried first, and **Reopen Recent Patch...** lists past
  reviews, including series.
- Offer the refresh prompt when a source patch is regenerated outside the editor, not only on save.
- Add **Copy Review Summary as Markdown**, **Mark All Reviewed**, **Clear Reviewed Checkmarks**, an
  unreviewed-count badge on Patch Reviews, and drag-and-drop of patch files onto the view.
- Add **Open Sample Patch** and **Copy Diagnostics** to make pre-release bug reports reproducible.
- Ship a web build: hunk-only reviews work in VS Code for the Web and virtual workspaces; Git-backed
  commands explain themselves instead of failing. New and not yet exercised in a real vscode.dev session.
- Pin the empty-window contract with integration tests: complete-file reviews find the repository through
  the patch file's own folder, and hunk-only reviews run, with no workspace folder or configured
  repositories. Document that an open workspace folder is optional.
- Repository hygiene: a structured bug-report form, CodeQL analysis, Dependabot updates, and a unit-test
  coverage report in continuous integration.

## 0.2.0

- Add opt-in **Open With** and explicit repository-free, partial-context hunk views.
- Review mailbox series and separate numbered patch files as cumulative changes and individual patches.
- Add the **Patch Reviews** summary, path filter, and per-file reviewed checklist.
- Reuse existing reviews, offer refresh on save, and preserve checkmarks only for unchanged changes.
- Keep open reviews intact beyond twenty views and release content after the last owned tab closes.
- Show binary fingerprints, marked text encodings, and persistent rename/mode/submodule metadata.
- Cancel and time-bound Git operations, enforce input/output/content budgets, and prevent lazy object fetching.
- Keep Git's own diagnostics for Windows closed-pipe errors without hiding genuine input failures.
- Strengthen scratch-object isolation and test source repository bytes, modes, and timestamps for invariance.
- Gate publishing on all supported-platform checks, including the oldest supported editor and real Restricted Mode.
- Require a clean dependency audit before packaging and publishing verification can pass.

## 0.1.0

First release.

- Open a `.patch` or `.diff` file, or unsaved patch text, as one Changes view of the complete files.
- Find the repository and base from the commit named in a `git format-patch` or `git show` file, or by trying `HEAD`
  in each repository.
- Choose the repository and base yourself.
- Leave the repository untouched: both sides are read from a temporary index and served from memory.
