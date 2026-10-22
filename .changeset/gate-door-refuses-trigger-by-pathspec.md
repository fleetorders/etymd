---
"etymd": patch
---

Two gate fixes (pack 28). A screen override (`CONTENT_GATE`, `COMMIT_MSG_GATE`) naming a
missing or non-executable checker now refuses the commit or push, with a line naming the
path and the two ways out (point it at an executable etymd, or unset it). Since pack 23 the
door announced the misconfiguration on stderr and opened; a hook that passes shows its stderr
to nobody in a GUI client, so a typo in the one variable set to tighten the gate turned it
off unseen. An unset override stays the silent no-op it was.

The pre-push whole-tree trigger (a commit touching the gate, its classifier or a
`.shellcheckrc` is checked whole, deletions included) is asked of git by pathspec instead of
reading the NUL-delimited touched list as lines. A tracked path holding a newline split into
two records, and a name ending in `pre-push` just before the newline forced the whole-tree
read for a file that was not the gate. The call clears `GIT_LITERAL_PATHSPECS` so an exported
literal mode cannot read the glob as a plain path and take the narrow path in silence.
