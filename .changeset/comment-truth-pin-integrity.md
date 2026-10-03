---
"etymd": minor
---

Two new lenses run with the normal audit. `comment-truth` checks source-code comments the
way instruction files are checked: a comment citing a command, path, doc page or decision id
is a claim, and one whose reference died is reported with file and line — many comments
citing one dead reference collapse into a single finding. Extraction is per language and
string-aware, so text inside a string literal never becomes a claim; test, fixture, mock and
vendor files are counted and disclosed as skipped, never silently dropped. `pin-integrity`
judges dependency pins (`overrides`, `resolutions`, `patchedDependencies`) by offline
lockfile arithmetic: an override nothing in the tree requests any more, or a patch whose
target version the lock no longer carries, is a dead pin the manifest no longer means; a pin
the lockfile cannot judge is disclosed, never flagged.
