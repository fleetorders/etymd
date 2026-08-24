---
"etymd": minor
---

gates: generated pre-push steps run scrubbed of git's exported GIT\_\* environment

Git exports `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / … to every hook it
runs, and a child `git` that inherits them ignores its cwd. A test suite that
builds fixture repositories by shelling out to `git` therefore operates on the
REAL repository — committing into it, moving its refs — while the same suite
outside a hook is harmless, which is exactly why the defect hides: nothing run
from CI ever reproduces it. This changes the generated pre-push (`etymd gates`,
pack v11):

- **Every gate step runs through a `run_gate()` helper** that strips every
  exported `GIT_*` name before the command runs — each name found in the
  environment, not a fixed list, because git adds variables over time. A step
  that genuinely means the repository finds it again from its working
  directory, which for a hook is the repo root.
- **The audit and shellcheck steps stay unscrubbed**, deliberately: audit
  operates on the repo it is invoked in and never descends into fixtures, and
  shellcheck's `git ls-files` must see the real repo.
- **The `.local` companion note documents the wrap**, so a hand-written guard
  that runs tests can scrub the same way — the companion is where repo-owned
  suites live.

Existing hooks pick this up on the next `etymd gates` run.
