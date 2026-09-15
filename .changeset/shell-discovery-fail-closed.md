---
"etymd": patch
---

Generated pre-push hooks preserve long filenames, whitespace, quotes, and leading hyphens
during shell-script discovery and checking. Discovery now fails closed instead of reporting
success with incomplete coverage: failed enumeration blocks, and a tracked regular file that
exists but cannot be read blocks, naming the file. Tracked paths with nothing readable behind
them — submodule entries, dangling symlinks, files deleted from the worktree while still
tracked — are counted and disclosed as skipped rather than blocking, so a submodule can no
longer wedge every push. Shebang reads are bounded to the first 4 KiB of the first line, so a
large binary cannot be copied into the gate's scratch file on every push and a shebang
embedded deeper in a document no longer drags the whole document into the checker.
Regenerate existing hooks with `etymd gates --yes` to apply the correction.
