---
"etymd": minor
---

Three fixes to the generated gates and the onboarding flow:

- **zsh is out of the shellcheck scan (pack v10).** The generated pre-push discovered shell
  scripts by a shebang pattern that included zsh, but shellcheck cannot parse zsh — SC1071 is a
  parser-level error no inline directive silences — so a repo whose executable surface is zsh
  could never push. zsh shebangs are now excluded from the checked set and the hook prints the
  exclusion (count + reason) at run time instead of going quiet about coverage. Pack v9 is skipped so no two
  template meanings ever share a version.
- **`~/` home paths are no longer repo file references.** Prose like "global rules in
  `~/.claude/CLAUDE.md` apply on top" made the audit demand a repo-root CLAUDE.md that was
  never meant to exist — the sentence points at the reader's machine. Home-path mentions of
  well-known docs are now skipped and disclosed, like absolute tokens; one ordinary mention
  still makes the doc a live claim.
- **`init` no longer scaffolds AGENTS.md unasked.** `init -y` in a repo without a contract used
  to write template prose nobody reviewed (and baseline it, making later deletion read as
  drift). The scaffold is now opt-in via `--with-agents`; interactive runs still ask first.
