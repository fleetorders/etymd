---
"etymd": minor
---

The fleet manifest's second profile is now `guarded` (was `guarded`), with every derived name
following: `guardedHosts` in the local file, `--profile guarded`, the `guarded/<name>/` persistence
zone beside the manifest, and the guarded-worktree wall checks. No alias for the old value: a
manifest still carrying it fails `fleet check` and names the entry. Prose and examples describe the
feature as a second, guarded workspace whose entries stay alias-only and machine-pinned.
