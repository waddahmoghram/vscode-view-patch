# View Patch

Review `.patch` and `.diff` files in one side-by-side **Changes** view in Visual Studio Code (VS Code).
Use complete files from a Git repository, or explicitly review just the patch hunks without any repository.

![A patch opened as one Changes view, showing changed files side by side](images/screenshot.png)

The **Patch Reviews** panel in the Explorer keeps the repository, base, file list, and review checklist alongside
the diff. The extension stays read-only and offline.

## Open a patch

- Right-click a patch in the Explorer and choose **Open Patch as Changes**.
- Choose **Open With...** > **View Patch (Changes)**. This is opt-in; installing the extension does not replace the
  normal text editor for patch files.
- With a patch open, use the **Open Patch as Changes** button in the editor title bar.
- Run **View Patch: Open Patch as Changes** from the Command Palette. Pasted, unsaved text also works when its editor
  language is Diff.

Selecting several files with the ordinary command opens independent reviews. To apply dependent patches in order,
use the series command below.

## Review complete files

A patch normally contains only edited lines and their surrounding context. For a complete-file review, View Patch
applies it in a private scratch area and reads each file before and after the change.

The extension searches:

1. repositories in the Source Control view;
1. workspace folders;
1. the patch file's folder;
1. extra folders in `viewPatch.repositories`.

When a `git format-patch` or `git show` file names a commit present in one of those repositories, the base is that
commit's parent. Otherwise, View Patch tries `HEAD` in the candidate repositories and asks when several apply.
The summary shows both the requested base and its frozen snapshot tree identifier.

An open workspace folder is not required: in an empty window, the patch file's folder and `viewPatch.repositories`
still locate the repository, and [hunk-only views](#review-hunks-without-a-repository) need none at all.

Use **Open Patch as Changes on a Repository and Base...**, or **Change Repository and Base...** on a review, to
choose a repository and revision yourself.

## Review hunks without a repository

Run **View Patch: View Patch Hunks Only**, or choose **View Hunks Only** when a complete-file review cannot apply.
This mode needs neither Git nor workspace trust.

The title, summary, and document headers explicitly say **partial context**. Only lines actually present in the
patch are shown, with original line ranges and omitted-context separators. Missing file contents are never invented.
Binary payloads are not reconstructed; only their supplied metadata is shown.

This is an explicit choice, not a silent fallback from a failed complete-file review.

## Review a patch series

- Open a mailbox containing several messages from `git format-patch --stdout` as an ordinary patch.
- Or select separate patch files and run **View Patch: Open Selected Patches as Series...**. The command also offers
  a multi-file picker. Numbered messages or filenames are sorted numerically; otherwise selection order is kept.
  Duplicate numbers are rejected rather than guessed.

Each patch is applied to the preceding patch's result in one private scratch area. **Patch Reviews** offers the
combined result and each individual patch, including subjects and authors. Cover letters are not applied as changes.
If the combined result has no net changes, the individual patches remain reviewable.

A hunk-only series shows individual messages, not a fabricated complete-file or cumulative reconstruction.

## Summary, checklist, and refresh

Expand **Patch Reviews** in the Explorer, or run **View Patch: Show Patch Reviews**.
Expand **Review Details** for the selected patch's subject, author, date, snapshot identifier, and detailed counts.
The panel divider can be dragged upward to give a large checklist more room.

- See the repository, base, subject, author, date, and added/modified/deleted/renamed file counts.
- Filter old and new paths with the filter button.
- Toggle each file's **reviewed** checkmark. Selecting a file opens its individual diff.
- Inspect mode changes, submodule pointers, and renames without edits as explicit metadata entries rather than
  temporary notifications.
- Reopening the same source reuses its review instead of accumulating duplicate tabs.
- Use **Refresh Review** after editing the patch. Saving an open source patch also offers to refresh; it does not
  silently replace the snapshot you were reviewing.

Refresh keeps the selected repository and base expression. Checkmarks survive only for changes whose contents and
metadata are unchanged. Series navigation replaces the review's current Changes tab rather than opening a tab per
message.

Review contents and checkmarks live only in this window. After restarting or reloading VS Code, open the patch again.

## Read-only, bounded operation

Your repository's working tree, index, references, and objects are not modified. Git uses a private index and object
database, and object-writing commands cannot access the source alternates. Scratch data is removed on success,
failure, cancellation, and limits. Missing objects are not fetched from a remote.

Both sides are then served as read-only, in-memory documents. There is no arbitrary twenty-review eviction:
content remains available while its Changes tab or individual file diff is open. Closing the last owned tab releases
the extension's buffers.

Binary and undecodable files show their sizes and content fingerprints, so equal-size binary changes cannot look
identical merely because their lengths match. Text with recognized byte-order marks is decoded explicitly.

Loading progress has a **Cancel** button. Default limits use mebibytes (MiB), where one MiB is 1,048,576 bytes:

| Limit                           | Default                 | Setting                       |
| ------------------------------- | ----------------------- | ----------------------------- |
| Input patch or assembled series | 10 MiB                  | `viewPatch.maxPatchSizeMiB`   |
| Unique loaded file content      | 64 MiB per review       | `viewPatch.maxContentSizeMiB` |
| Retained open file buffers      | 128 MiB                 | `viewPatch.maxOpenContentMiB` |
| Each Git command                | 30 seconds              | `viewPatch.gitTimeoutSeconds` |
| Combined Git output             | 64 MiB per command      | fixed                         |

Limits fail explicitly; they do not truncate content or evict another open review. Close reviews or adjust the
appropriate setting before retrying. The retained-content limit counts file buffers, not VS Code's own text models
or all JavaScript object overhead. The output limit includes both standard output and standard error.

Set these options in user or remote settings, not workspace settings. `viewPatch.repositories` defaults to `[]`;
a leading `~` in an extra repository path means your home folder.

## Requirements and limits

- VS Code 1.90 or newer.
- Git on `PATH`, or configured through `git.path`, for complete-file reviews.
- Workspace trust for Git-backed reviews. Hunk-only views work in Restricted Mode.
- In a remote window, the extension and Git-backed operations run next to the remote repositories.
- Git and standard unified diffs are supported. Malformed/truncated hunks and combined merge diffs are rejected
  explicitly. Encoded mail bodies are not decoded.

## Privacy and troubleshooting

View Patch does not collect telemetry, contact a hosting service, or fetch missing objects. The **View Patch** output
channel (**View** > **Output**) explains repository selection, cancellation, limits, and Git failures.

## License

[MIT](LICENSE)
