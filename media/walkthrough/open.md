# Open a real patch

Use the window that can reach the repository.
For a local repository, use the local desktop window.
For a repository on another machine, connect Visual Studio Code through Secure Shell (SSH) and install View Patch
on that host.
Check **Show Environment** before opening the patch; switching windows can also change the loaded extension version.
In the browser, **Open Patch as Changes** opens hunks only because the browser cannot run Git.

Any of these work:

- Right-click a `.patch` or `.diff` file in the Explorer → **Open Patch as Changes**.
- Drag patch files onto the **Patch Reviews** panel.
- Copy patch text anywhere, then **View Patch: Open Patch from Clipboard**.
- Paste into an editor, set its language to **Diff**, and run **Open Patch as Changes**.

For complete files, View Patch looks in Source Control repositories, workspace folders, the patch file's own
folder, and the `viewPatch.repositories` setting.
When a `git format-patch` file names its commit, the commit's parent becomes the base.

The reviewed repository is never modified: no working-tree, index, reference, or object writes.

Generate demo patches with Git rather than typing them; hand-made diffs often break on hunk counts or a context
line's leading space, and the error message explains what is wrong.
