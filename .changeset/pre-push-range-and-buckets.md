---
"etymd": patch
---

Four refinements to the generated pre-push gate, shipped together. A new branch's push range
is bounded by the remote actually being pushed to: commits only OTHER remotes hold were gated
by nobody (a fetch runs no hooks), so they stay in the range and are read here, while commits
the pushed-to remote already received drop out; a push that names a URL instead of a
configured remote keeps the wide bound, because `--remotes=<url>` matches no refs and would
check a fresh clone's entire history. A hand run of the hook from a terminal no longer hangs
waiting on stdin that never arrives — the pushed refs are read only when stdin is not a
terminal, and a terminal run says so. Scripts under interpreters outside the sh dialects
(ksh, ash) are counted in their own bucket and announced like the zsh exclusion, instead of
leaving the coverage accounting silently short of them. And a checked scratch tree that
cannot be removed after the checks pass refuses the push naming the leftover directory,
instead of exiting nonzero with no diagnosis. Regenerate existing hooks with
`etymd gates --yes` to apply.
