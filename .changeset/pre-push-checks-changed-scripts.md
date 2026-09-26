---
"etymd": patch
---

Generated pre-push hooks check only the shell scripts each pushed commit changes, instead of
every script in every pushed commit's tree. A commit that changes the gate itself, its
classifier or a `.shellcheckrc` (deletions included) is still checked whole. So is the commit
that installs the gate, which reads a repo's existing scripts once. A commit with no shell
script says so. Pointer checks no longer accept an `@AGENTS.md` import inside a fenced code
block, an unreadable Claude Code version counts as too old instead of passing, and `init` warns
when a `CLAUDE.md` or `.claude/CLAUDE.md` hides `AGENTS.md`. Regenerate existing hooks with
`etymd gates --yes` to apply the change.
