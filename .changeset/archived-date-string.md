---
"etymd": patch
---

A fleet manifest entry's `archived` field archives the entry only when it
is `true` or a date string. Any other non-empty string — "false", "no",
"0", a typo — used to archive the entry with no problem raised, hiding the
project from every check; such a value is now reported as bad shape and
the entry stays live.
