---
"etymd": patch
---

`comment-truth` reads a missing path's nested-package frame from the
commenting file's own position: a path found under a nested package is
treated as written from that package only when the commenting file sits
inside it. The old check accepted any package's copy of the path — in a
monorepo some package always holds a file at the same relative spot, so a
deleted root-level `src/...` path could no longer be caught anywhere. The
wording in docs/decisions.md (D-014) and docs/limitations.md follows the
new scope.

A dangling doc reference is now read by the same word rules as the same
mention through the path checker: a doc name introduced as an example is
an example in both, never flagged in one and reported in the other.
Decision references cite labels, not paths, and stay outside the rules.

A run that knows no sibling repository names — a local audit, which gets
them only from the fleet sweep — now discloses that the sibling-name skip
could not be applied, instead of checking differently from the sweep with
nothing said.
