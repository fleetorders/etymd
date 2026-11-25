---
"etymd": patch
---

Release notes now position etymd beside Claude Code's native
`/doctor prompt-audit` (added in 2.1.283): the two audit different halves
of an agent's instructions, and etymd stays the single source for the
repository half on every harness.

- Only the native audit sees the loaded session surface: user-level
  skills, commands and memory indexes, frontmatter conventions across
  them, model names pinned inside dated records, and the vendor plugin
  inventory. A repository checker cannot see any of that; none of it is
  keyed to a repository.
- Only etymd sees the repository surface: source comments (stale paths,
  dead commands, dangling doc and decision references), dependency pins,
  CI-versus-local gate parity, context budgets against the committed
  baseline, the decisions record's freshness, and the task an agent is
  handed — checked the same way whichever agent reads the files.
- The overlap is instruction-file truth: both check paths and commands
  that instruction files name. etymd checks them against the repository
  itself and remembers findings between runs; the native audit checks
  them against the loaded session, where a repository checker has no
  standing.

A repository serving one harness benefits from both audits; a repository
serving several has etymd as the only audit that follows the files rather
than the harness.
