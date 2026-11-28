---
"etymd": minor
---

`etymd audit --fix` — the audit applies the mechanical fixes it owns
before reporting.

The first (and so far only) fixable class is decisions-file id order: a
`DECISIONS.md` whose `## D-NNN` blocks sit out of append order is
rewritten with whole blocks moved into id order. No word and no id
changes, only the order; each move is reported by id and by position
before and after, and the audit then re-runs on the fixed files, so the
report shows what remains, not what it just repaired. Duplicate ids keep
their relative order (a stable sort — ordering never renames), and a
non-decision `##` section sitting between D-entries makes the reorder
refuse with the reason named rather than guess where it belongs.

The id-order finding's advice changed to match: move the whole block
into id order — previously it suggested renaming the entry, which no
repair should do to an append-only record.
