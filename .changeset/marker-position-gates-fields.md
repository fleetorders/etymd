---
"etymd": minor
---

Declared-field checks are forward-only from the marker's position, not from the file. A decisions
file that declares required entry fields mid-life no longer demands them from the entries appended
above the marker — an append-only record cannot backfill them. The built-in `Scope:` check shares
the same gate; `Revisit:` keeps whole-file reach, since it fires only where the entry already wrote
a date down. Entries exempt by position are counted and named in the lens disclosures.
