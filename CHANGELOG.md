# Changelog

## 0.2.0

- Add opt-in **Open With** and explicit repository-free, partial-context hunk views.
- Review mailbox series and separate numbered patch files as cumulative changes and individual patches.
- Add the **Patch Reviews** summary, path filter, and per-file reviewed checklist.
- Reuse existing reviews, offer refresh on save, and preserve checkmarks only for unchanged changes.
- Keep open reviews intact beyond twenty views and release content after the last owned tab closes.
- Show binary fingerprints, marked text encodings, and persistent rename/mode/submodule metadata.
- Cancel and time-bound Git operations, enforce input/output/content budgets, and prevent lazy object fetching.
- Strengthen scratch-object isolation and test source repository bytes, modes, and timestamps for invariance.
- Gate publishing on all supported-platform checks, including the oldest supported editor and real Restricted Mode.

## 0.1.0

First release.

- Open a `.patch` or `.diff` file, or unsaved patch text, as one Changes view of the complete files.
- Find the repository and base from the commit named in a `git format-patch` or `git show` file, or by trying `HEAD`
  in each repository.
- Choose the repository and base yourself.
- Leave the repository untouched: both sides are read from a temporary index and served from memory.
