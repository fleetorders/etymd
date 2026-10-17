---
"etymd": patch
---

The pre-push audit worktree is now a tree git can enumerate, with binaries to check
commands against (pack 27).

`worktree add --no-checkout` leaves the worktree's index empty, so inside the
materialised tree `git ls-files` listed nothing while every file sat on disk: the
comment lens answered "could not run" and the shell-script count was zero — the
audit passed silently without ever running them. `read-tree` now fills the index
from the pushed commit directly — no checkout runs, no filter, the raw-blob rule
holds.

And the audit tree had no `node_modules`, so every command claim matching no package
script was skipped as "unverifiable — node_modules is not installed"; a pushed
`npm run nope` in AGENTS.md passed the gate that exists to catch it. Installed
binaries belong to the checkout, not the commit, so the checkout's `node_modules`
is linked into the audit tree — best effort, and a committed `node_modules` path
stays the commit's.

Regenerate existing hooks with `etymd gates --yes`.
