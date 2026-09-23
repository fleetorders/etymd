---
"etymd": minor
---

The Claude Code pointer check follows Claude Code 2.1.277, which reads `AGENTS.md` when a
directory has no `CLAUDE.md`. A repo with `AGENTS.md` alone now passes and `fleet add` registers
it; it is reported (`claude-pointer-missing`, tier gap) only when the installed Claude Code is
older than 2.1.277, and `fleet add` prints a note instead of refusing. A `CLAUDE.md` that exists
without importing `@AGENTS.md` stays a risk and a refusal, because Claude Code reads that file
instead on every version. The version is read from `claude --version`; `ETYMD_CLAUDE_VERSION`
pins it, and `none` means no Claude Code on the machine.
