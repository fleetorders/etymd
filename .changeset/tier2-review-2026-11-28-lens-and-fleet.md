---
"etymd": patch
---

Lens and fleet fixes from an independent review of 2026-11-28.

- The comment lens no longer truncates a file's findings at ten: a
  still-broken command behind twelve stale paths used to vanish from the
  run, and the ledger marked it done on the next audit. All findings are
  reported; a disclosure names the flood instead of hiding evidence.
- A workspace package no longer vouches for a root-level comment's path.
  The instruction-file monorepo rule (any package's copy satisfies any
  claim) masked source comments: a root comment naming `src/index.ts`
  passed while only `packages/shared/src/index.ts` existed. A package now
  frames only the comments written inside it, at the resolver too.
- A capitalised "For example" marks its path an example again — the cue
  pattern had lost its case-insensitive flag, so the same words with a
  capital F turned an illustrative path into a stale-path finding.
- A `../` path that resolves outside the repository (a root-level comment
  naming a sibling checkout) is read as quoted from elsewhere, not
  reported missing inside the repo; the same words from a nested file
  still point inside and stay checkable.
- A date-shaped string that is no calendar date (`2026-99-99typo`,
  `2026-02-30`) no longer archives a fleet entry silently: the whole
  string must be a real date, or the entry stays live with a bad-shape
  problem.
- An archived entry with the `guarded` profile no longer shows in `fleet board`'s
  archived note: the note now follows the rule the rows always had — guarded
  entries never appear — and the JSON and saved Markdown read the same list.
- A working `CLAUDE.local.md` pointer no longer makes `fleet add` refuse
  registration: a local file that symlinks AGENTS.md or imports it with
  `@AGENTS.md` carries the contract exactly like a CLAUDE.md pointer.
- The installer's shell detection counts the ksh family (`.ksh` files and
  ksh/mksh/pdksh/oksh/lksh shebangs), so a ksh-only repository no longer
  counts zero scripts and silently loses its shellcheck gate.
