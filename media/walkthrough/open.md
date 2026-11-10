# Open a real patch

Any of these work:

- Right-click a `.patch` or `.diff` file in the Explorer → **Open Patch as Changes**.
- Drag patch files onto the **Patch Reviews** panel.
- Copy patch text anywhere, then **View Patch: Open Patch from Clipboard**.
- Paste into an editor, set its language to **Diff**, and run **Open Patch as Changes**.

View Patch finds the patch's repository automatically — Source Control repositories, your
workspace folders, the patch file's own folder, and the `viewPatch.repositories` setting.
When a `git format-patch` file names its commit, the commit's parent becomes the base.

The reviewed repository is never modified: no working-tree, index, reference, or object writes.

Generate demo patches with Git rather than typing them — hand-made diffs usually break on
hunk counts or a context line's leading space, and the error message will say exactly that.
