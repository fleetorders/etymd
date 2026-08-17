---
"etymd": minor
---

Content screen: allow-file entries carry provenance, and the env bypasses are gone

Every exemption is a hole in the gate, and a hole with no name on it lives forever — nobody can
ask "is this still needed?" about an entry nobody signed. Repo-level exceptions now live in
`.etymd-screen-allow` (the previous `.artifact-check-allow` is still honoured) as records of
labeled lines:

```
pattern ^/Users/someone
reason test fixture for machine-path detector
date 2026-08-15
author owner
```

The pattern is the rest of its line, verbatim — it may contain any character, `|` included,
without escaping. Delimiting a free-form field in-band would be an ambiguity in the format
itself, and every parser-side guard against it only makes the misparses you imagined loud while
leaving the rest silent; the line break is the one boundary the field cannot contain.

An entry naming the repo itself needs no provenance — a bare `^widget$` line is a complete
record, the exemption being exactly as wide as the name. Anything else missing a field is
reported and does not apply, so an unprovenanced file reads as noise to fix, not as silence to
trust.

The two environment bypasses the generated hooks carried — `CONTENT_GATE_PREPUSH` and
`ARTIFACT_CHECK_SKIP` — are removed. They were off-switches invisible in the tree: nothing in
the repo records that a gate was skipped, or why. The allow file is the one bypass path left,
and every entry in it says who exempted what, when, and for what reason.

Generated hooks now resolve their screener in a defined order: an explicit `CONTENT_GATE`, then
the repo's own `./dist/cli.js` when it builds one, then the `etymd` on PATH. The middle step is
the dogfood case — a repo developing the screener must gate on its own unreleased build, or its
hooks enforce the last published behaviour against a tree that has moved past it. Repos without
a `dist/` resolve exactly as before. Pack v8 — run `etymd gates` to pick it up.
