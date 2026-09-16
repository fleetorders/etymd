---
"etymd": patch
---

`core.hooksPath` is read the way git reads it: a repo-relative path, an absolute path and a `~`
path can all name one directory, and the directory is the fact. An absolute path to the tracked
`.githooks/` now scans as `githooks` (wired) instead of `custom`, and the hooks are read from the
directory git actually runs — the literal-string comparison had also joined the absolute path
onto the repo root and looked for hooks at a path that does not exist, so a working pre-push gate
could read as absent. The fact is recorded repo-relative whenever the directory sits inside the
worktree, so a committed baseline never carries a machine path; a hooks directory outside the
repo stays absolute and is disclosed as `custom`.
