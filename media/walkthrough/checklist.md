# Track your review

The **Patch Reviews** panel in the Explorer keeps everything beside the diff:

- Repository, base, subject, author, and per-kind file counts.
- A **reviewed** checkmark per file; hover its row and click **Toggle Reviewed**.
  Clicking the filename opens its individual diff.
  Screen-reader labels include reviewed/unreviewed state and partial context.
- **Next/Previous Unreviewed File** commands walk the remaining work; the optional
  `viewPatch.markReviewedOnOpen` setting checks files off as you open them.
- **Mark All Reviewed**, **Clear Reviewed Checkmarks**, and a badge counting what's left.
- **Copy Review Summary as Markdown** for pasting into a review thread, and
  **Copy Diff for This File** on any file entry.

Try marking one file reviewed, then run **Refresh Review**.
Its mark should remain if the represented content has not changed.
For a saved patch file, reload the window and run **Reopen Recent Patch...**, then select that patch.
Its unchanged checkmarks should still be there.
Unsaved clipboard, pasted, and sample patches are not added to recent history; save the patch first if you need to
reopen it later.
If the source patch changes on disk, View Patch offers a refresh instead of silently swapping the snapshot you
were reading.
