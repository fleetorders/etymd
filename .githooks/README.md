# How git reaches these hooks

Everything in this directory except the `*.local` guards is etymd's generated gate pack,
this README included (see the `etymd:generated` stamps at the end of each file). `etymd gates`
installs the pack and points git at it by setting `core.hooksPath` to `.githooks` — that
setting is machine-local, which is why git runs these hooks in this checkout and not in a plain
clone; there they sit inert until `etymd gates` runs again or you set `core.hooksPath` by
hand. Of the checks inside, only the `screen` calls need etymd — the shell correctness and
audit checks in `pre-push` need nothing but their tools being on PATH. Where no checker is
installed (`CONTENT_GATE` and `COMMIT_MSG_GATE` unset, no etymd on PATH) the screens are
silent no-ops by design and the commit passes; only an override that is set but does not point
at an executable checker is loud, and it refuses. A later `etymd gates` run overwrites the
generated files (it asks before clobbering hand-edited ones, and a hand-edited file it keeps
stops receiving fixes), so fixes to any of them, this one included, belong upstream in etymd's
pack; your own guards go in `pre-push.local`, `pre-commit.local` or `commit-msg.local`,
which etymd never reads, writes or regenerates.

<!-- etymd:generated pack-v31 b4fdaac2a1d0662f -->
