---
"etymd": minor
---

`etymd gates` can now check the commit subject against Conventional Commits, at the commit-msg
door the content screen already used. Pack v7 — run `etymd gates` to pick it up.

**Off unless you ask for it.** Set `gates.commitFormat: true` in `.etymd/config.json`; anything
else, including leaving the key out, writes exactly the hook you got before this release. It is
the one generated check that needs nothing installed and would therefore run for everyone who
clones your repo — every other check the pack writes is either derived from what your repo
already does, or inert without a checker you installed yourself. A commit convention is neither.
It is an opinion, and this tool does not hold opinions on your behalf.

Where you do turn it on, it is a format check and not a taste check: it asks whether a machine
can classify the subject and stops there. An over-long subject is advice and never blocks, and
the subjects git writes for you (merge, revert, fixup, squash, amend) are exempt.
