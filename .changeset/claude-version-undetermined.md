---
"etymd": patch
---

A Claude Code version that cannot be read is disclosed, never silently clean. The version probe
behind `claude-pointer-missing` is three-state: ENOENT still means "no Claude Code" (a pass — no
reader to warn about), but a timeout, a broken shim, versionless output, or an
`ETYMD_CLAUDE_VERSION` pin that is not `X.Y.Z` is reported as undetermined — the sweep prints a
disclosure, `fleet add` prints a note naming the pin to set. Previously any probe failure read as
"no Claude Code", and a typo'd pin (`latest`, `2.1.x`) reached the version comparison as `NaN`,
which compares as current — both shapes silently disabled the old-reader check. `init` also
scaffolds the `CLAUDE.md` pointer only where the local reader needs one (a Claude Code older
than 2.1.277, or an undetermined one): on a current install AGENTS.md alone is the shape this
package's own repo wears, and init says why it skipped.
