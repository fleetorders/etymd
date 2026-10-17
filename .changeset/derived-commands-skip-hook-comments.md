---
"etymd": patch
---

`etymd gates` no longer reads a hook's comment lines as the repo running a command.
The generated pre-push hook carries a comment about padded `wc` output that reads
"an integer test on a padded read" — the derivation matched the bare word `test`,
so the second `etymd gates --yes` in any repo wired `run_gate npm run test` into the
hook, every regeneration rewrote it, and the full test suite landed in every push.
Comment lines are now stripped before the test: the wired step (`run_gate … test`)
and a hand-written `npm test` line are code and still count.
