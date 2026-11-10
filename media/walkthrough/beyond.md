# Compare versions and review commits

**Compare with Another Patch...** applies the open review's patch and a second version to the
same frozen base, then shows the result difference — how v2 differs from v1, not a diff of
the patch files themselves.

**Review a Commit...** needs no patch file at all: pick a repository and any revision, and the
commit's real changes open as a review — per parent for merge commits, against the empty tree
for a root commit.

Mailed patches with `quoted-printable` or `base64` bodies decode automatically, patch series
apply in order with per-patch sections, and combined merge diffs render per parent.
