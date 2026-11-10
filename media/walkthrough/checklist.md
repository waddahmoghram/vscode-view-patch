# Track your review

The **Patch Reviews** panel in the Explorer keeps everything beside the diff:

- Repository, base, subject, author, and per-kind file counts.
- A **reviewed** checkmark per file — click a file to open its individual diff.
- **Next/Previous Unreviewed File** commands walk the remaining work; the optional
  `viewPatch.markReviewedOnOpen` setting checks files off as you open them.
- **Mark All Reviewed**, **Clear Reviewed Checkmarks**, and a badge counting what's left.
- **Copy Review Summary as Markdown** for pasting into a review thread, and
  **Copy Diff for This File** on any file entry.

Checkmarks survive window reloads for unchanged patches, and **Reopen Recent Patch...**
brings back past reviews. If the source patch changes on disk — saved in the editor or
regenerated in a terminal — View Patch offers a refresh instead of silently swapping
the snapshot you were reading.
