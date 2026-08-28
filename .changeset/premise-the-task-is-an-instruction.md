---
"etymd": minor
---

`etymd premise "<task>"` — the task you hand an agent is an instruction too. Every path, script,
well-known doc and decision id the task names is verified against the repo (a missing thing the
task is _about_ ranks as risk), and a brief hands the agent the premises only it can verify.
`--file <path>` (`-` reads stdin), `--json` (schema `premise/1`), `--no-brief`, `--fail-on <tier>`.
Zero trace in a repo that never opted in; no ledger. Prose is read with stricter rules than a code
span (a script needs the `run` form, a directory claim needs a first segment that exists, a host
name is a URL) and every class left as prose is disclosed. The command/path/doc-reference/
decision-reference truth checks are now one shared implementation used by `instruction-truth` and
`premise` alike — ids, tiers and disclosures of existing findings are unchanged.
