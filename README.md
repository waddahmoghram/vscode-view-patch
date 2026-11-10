# View Patch

Open a `.patch` or `.diff` file as one **Changes** view in Visual Studio Code (VS Code): every file the patch touches,
side by side, as complete files before and after.

![A patch file opened as one Changes view, showing each changed file side by side](images/screenshot.png)

A patch file holds only the changed lines and a few lines around them. View Patch applies the patch to the Git
repository it came from, in a scratch area, so you review whole files with syntax highlighting and VS Code's own diff
navigation. Your repository is never changed.

## Open a patch

- In the Explorer, right-click a `.patch` or `.diff` file and choose **Open Patch as Changes**. Select several patch
  files to open each in its own view.
- With a patch open in the editor, select the **Open Patch as Changes** button in the editor title bar. This also works
  for patch text pasted into an unsaved editor whose language is Diff.
- From the Command Palette, run **View Patch: Open Patch as Changes**.

## How View Patch finds the repository and base

View Patch looks in these repositories, in this order:

1. repositories open in the Source Control view;
1. the workspace folders;
1. the folder that holds the patch file;
1. the folders in the `viewPatch.repositories` setting.

A patch made by `git format-patch` or `git show` names its commit on the first line. When one of those repositories
has that commit, View Patch applies the patch on the commit's parent, so it applies cleanly even after the branch has
moved on.

Any other patch is tried on `HEAD` in each repository. When it applies in more than one, View Patch asks which one to
use.

To choose for yourself, run **View Patch: Open Patch as Changes on a Repository and Base...**, pick a repository, and
type the commit, branch, or tag to apply the patch to.

## Your repository is not changed

Git applies the patch in a temporary index and object folder that only read your repository's objects, and View Patch
deletes them as soon as it has read both sides of each file. Your working tree, index, branches, and object database
are never written.

The Changes view is read-only, and its contents live in memory for the 20 most recent views. After VS Code restarts or
reloads the window, open the patch again to see it.

## Changes without a side-by-side view

These changes have no content difference to show, so View Patch lists them in a notification instead:

- submodule pointer updates;
- mode-only changes, such as making a script executable;
- renames without edits.

A binary file is shown as a one-line placeholder with its size.

## Settings

- `viewPatch.repositories` (default `[]`): extra repository folders to search when a patch's repository is not open in
  the window. A leading `~` means your home folder. Set it in user or remote settings, not in workspace settings.

## Requirements

- Git, either on your `PATH` or set in the `git.path` setting.
- A trusted workspace. View Patch runs Git, so in Restricted Mode it asks you to trust the workspace first.
- In a remote window, View Patch runs on the remote machine next to your repositories, so Git must be installed there.

## Privacy

View Patch makes no network requests and collects no telemetry. It runs only your local `git`.

## Troubleshooting

The **View Patch** output channel (**View** > **Output**) logs the repositories that were tried and Git's reason when a
patch did not apply.

## License

[MIT](LICENSE)
