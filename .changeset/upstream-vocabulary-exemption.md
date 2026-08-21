---
"etymd": minor
---

screen: forks can exempt upstream-owned files from vocabulary-class patterns

A fork that syncs from upstream stages hundreds of upstream files; a pattern that
matches ordinary wording (a "vocabulary" pattern, e.g. words a leaky *description*
would use) then fires on upstream's own already-public docs and blocks the sync
commit. This adds:

- **Pattern classes.** A `# class: vocabulary` directive in the pattern file marks
  the patterns beneath it as vocabulary; everything else stays `secret`. Files with
  no directive are unchanged — every pattern absolute.
- **Upstream ownership by blob identity.** With `--upstream <remote>` or
  `git config etymd.upstream <remote>`, a staged/tree file whose content matches any
  blob at the tips of `refs/remotes/<remote>/*` is upstream-owned, and its
  vocabulary-class patterns are skipped. Secret-class patterns and the machine-path
  check stay absolute everywhere. Matching is by blob sha across all upstream refs,
  so a file copied verbatim to a different path (an adapter lifted from another
  upstream branch) is still recognised, and a file the fork *modifies* is screened
  in full.
- **Fails closed and loud.** If the upstream ref cannot be read (a rebuild dropped
  the remote), nothing is exempted and a one-line notice says so — the config signal
  persists so the fork still knows it is a fork.
