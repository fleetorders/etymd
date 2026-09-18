---
"etymd": patch
---

Generated pre-push hooks shellcheck every commit in the pushed range, each materialised from
git's object store, instead of reading the working tree. A push whose tip is clean but whose
earlier commits carry a broken script is now refused; the working tree no longer substitutes
for the pushed bytes; a push that creates a branch checks every commit no remote already has;
and a commit that cannot be materialised refuses the push rather than passing as unread.
Regenerate existing hooks with `etymd gates --yes` to apply the correction.
