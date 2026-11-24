---
"etymd": patch
---

Gate pack fixes from two independent reviews of installed packs (pack 31).

- The shell classifier reads each shebang's interpreter once, as a name, and
  classifies it by family. A versioned or suffixed build (`bash5`, `zsh-5.9`)
  now lands in its family, and `env -S bash -e` reads as bash. Node, Python,
  Ruby, Perl and other non-shell interpreters no longer count as a shell
  coverage hole: the "script(s) under another interpreter" line now counts only
  shells the gate cannot check (ksh, ash, csh and the like), so it stops
  printing on every push of a repo with Node or Python tools.
- The checker-version stamp is written only when the push actually read a
  commit. A push with nothing in range (a delete, a terminal run) used to
  baseline a shellcheck upgrade that no whole-tree read had followed.
- A refused or interrupted push-time audit now deregisters its temporary
  worktree; it used to leave a registration pointing at a deleted directory
  behind every failed push.
- A `CONTENT_GATE` set to something unusable refuses the push at the start of
  `pre-push` rather than after the audit, and says it is a configuration error.
  The advisory screen's own findings still never block. Every broken-override
  message now points at "an executable checker that understands 'screen'"
  rather than at etymd alone.
- The generated `.githooks/README.md` says it is generated too, and states that
  the screens are silent no-ops where no checker is installed.
- Hook comments now state the push-time audit's tip-only read, the existing
  branch range's reliance on the remote's commits having been gated, and the
  direction in which the linked `node_modules` can let an older tip's claim
  resolve, rather than asserting rules the code does not follow.
