---
"etymd": patch
---

Four gate fixes (pack 29).

A shebang tail that is a carriage return or tab — the line a Windows editor
commits — now still counts the script. The classifier tails matched a literal
space or end-of-line, so such a script landed in no count at all, not even the
disclosed ones; they now match any whitespace.

The pre-push audit call resolves through `AUDIT_GATE` like the screens, with the
same door: an override naming a checker that is not executable refuses the push
naming the path and the two ways out. A checker old enough to predate
`--no-ledger`/`--fail-on` no longer blocks every push with a usage error — after
a failure the hook probes `audit --help`; a checker that knows both flags and
still fails blocks (a finding), one that does not gets an upgrade hint.

Both checker passes run with the staged tree as `HOME` and `XDG_CONFIG_HOME`:
the commit's rc files still apply by the walk from each script's path, but a
commit shipping no rc no longer falls back to the pusher's home, where a
personal rc made the same push pass on one machine and fail on another.

The advice split filters severities with two `-e` patterns instead of GNU-only
backslash-pipe alternation, which BSD grep matches literally.
