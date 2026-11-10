# Changelog

## 0.1.0

First release.

- Open a `.patch` or `.diff` file, or unsaved patch text, as one Changes view of the complete files.
- Find the repository and base from the commit named in a `git format-patch` or `git show` file, or by trying `HEAD`
  in each repository.
- Choose the repository and base yourself.
- Leave the repository untouched: both sides are read from a temporary index and served from memory.
