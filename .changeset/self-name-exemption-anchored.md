---
"etymd": patch
---

Content screen: recognise a repo's own name however the pattern spells it

The self-name exemption compared a pattern's raw source to the repo's directory name. Once a
pattern file started listing names word-anchored — `\bwidget\b` rather than `widget` — no source
matched any name, and the exemption silently stopped applying: a repo began reporting its own
`package.json`, its own contract titles and its own storage keys as leaks, enough of them to bury
anything else in the report. Nothing failed; the code, its comment and its test all still read as
correct.

The comparison is now of meaning rather than spelling. A pattern is exempt when the single
string it matches is one of the names the repo can prove is its own, with word anchors accepted
because they change where a match may begin, never which string matches. Any pattern that can
match more than one string — a class, a quantifier, an alternation — is never exempt, so an
exemption stays exactly as wide as a name.

"Its own name" also widens from the worktree directory to the union of the directory, the
`name` in `package.json` (npm scope stripped) and the basename of the `origin` remote, since
those three routinely disagree. Each is read from the repo being screened, so a repo can only
ever exempt itself; where none can be read the union is empty and every pattern stays active.
