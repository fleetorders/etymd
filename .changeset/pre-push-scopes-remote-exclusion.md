---
"etymd": patch
---

Generated pre-push hooks scope the new-branch commit enumeration to the remote being pushed
to (git names it as the hook's first argument) instead of subtracting every remote's tracking
refs: a commit this clone only has because it was fetched from a fork or a teammate's remote
was never gated for the target, and is now shellchecked like the rest of the push. A manual
hook run without the argument keeps the previous every-remote exclusion. `fleet add`'s
refusal for a repo whose only Claude file is `.claude/CLAUDE.md` now cites the observation
that pins it (Claude Code 2.1.283 loads only the `.claude/CLAUDE.md` in that shape; the
AGENTS.md fallback does not fire beside it), and `etymd init` says at scaffold time that a
kept CLAUDE.md without an `@AGENTS.md` import will be refused by `fleet add` later.
Regenerate existing hooks with `etymd gates --yes`.
