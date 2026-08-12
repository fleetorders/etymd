---
"etymd": minor
---

The commit-msg gate now checks the subject against Conventional Commits, alongside the content
screen it already ran. Pack v7 — run `etymd gates` to pick it up.

It is a format check, not a taste check: it asks whether a machine can classify the subject and
stops there. An over-long subject is advice and never blocks, and the subjects git writes for you
(merge, revert, fixup, squash, amend) are exempt. Unlike the screen it needs nothing installed, so
it is the one check in a generated hook that is not inert for whoever clones the repo — which is
why it is a declared key: `gates.commitFormat: false` writes the hook with the screen alone, for a
repo that keeps a different convention or none.

This is the door the tool was missing for the convention it is easiest to lose. A convention with
no gate is not abandoned in a decision anyone can point at — it erodes one hurried commit at a
time, and by the time the log reads as a mixture, every commit in it is already published.
