# How git reaches these hooks

Everything in this directory except the `*.local` guards is etymd's generated gate pack,
this README included (see the `etymd:generated` stamps at the end of each file). `etymd gates`
installs the pack and points git at it by setting `core.hooksPath` to `.githooks` — that
setting is machine-local, which is why git runs these hooks in this checkout and not in a plain
clone; there they sit inert until `etymd gates` runs again or you set `core.hooksPath` by
hand. Of the checks inside, the shell correctness pass in `pre-push` needs `shellcheck` on
PATH (absent, it skips with a line naming the install); the truth audit needs etymd itself
(absent, it skips with a line too — a push from a machine without etymd is screened but not
truth-audited); the `screen` calls need the checker your `CONTENT_GATE` and
`COMMIT_MSG_GATE` point at. Where no checker is
installed (`CONTENT_GATE` and `COMMIT_MSG_GATE` unset, no etymd on PATH) the screens are
silent no-ops by design and the commit passes; only an override that is set but does not point
at an executable checker is loud, and it refuses. A later `etymd gates` run overwrites the
generated files (it asks before clobbering hand-edited ones, and a hand-edited file it keeps
stops receiving fixes), so fixes to any of them, this one included, belong upstream in etymd's
pack; your own guards go in `pre-push.local`, `pre-commit.local` or `commit-msg.local`,
which etymd never reads, writes or regenerates.

<!-- etymd:generated pack-v38 9b5123938b219bbd -->
