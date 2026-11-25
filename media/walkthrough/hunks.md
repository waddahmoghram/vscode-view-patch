# View hunks only

**View Patch: View Patch Hunks Only** needs neither Git nor workspace trust.

It shows exactly the lines the patch carries, with original line numbers and explicit
omitted-context separators. Missing content is never invented; the title says
**partial context** so nobody mistakes an excerpt for the whole file.

For an open patch review, right-click its name in **Patch Reviews** and choose **Show Hunks Only for Review** or
**Show Complete Files for Review**.
These actions reuse the selected review and its original patch, even if another editor is active.
The repository and base choice are retained while that review stays open.
While the patch is unchanged, files listed in both views keep their reviewed marks; if the patch changed, the marks
are cleared.
The menu offers only the switch that applies.
Commit and version-comparison reviews are already complete snapshots and cannot switch modes.

Hunks-only mode also works in Restricted Mode, in virtual workspaces, and in Visual Studio Code for the Web.
Complete-file reviews need Git, the repository, and workspace trust on the machine running the extension.
In the browser, the menu does not offer complete files.
