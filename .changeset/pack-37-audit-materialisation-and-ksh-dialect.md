---
"etymd": patch
---

Gate pack 37: the push audit's materialisation refuses filesystem-level
escapes, and the ksh family's aliases are checked under the ksh dialect.

- The audit worktree's blob writer refuses two escapes the lexical
  path guard cannot see, both live on a case-insensitive filesystem (the
  default APFS): two distinct git paths that name one destination (`Foo`
  and `foo`), and a symlink staged for one entry that would carry a later
  entry's directory creation or blob write through itself, outside the
  tree the gate built. Both are refused like an escaping name.
- A clean `mksh`, `pdksh`, `oksh` or `lksh` script no longer blocks the
  push: shellcheck does not know those shebangs and answered SC1008 at
  error severity — over the gate's bar — for scripts that were clean.
  They are still checked, never excluded: staged to their own list and
  read with `--shell=ksh`, held to the same verdict bar as the rest.
