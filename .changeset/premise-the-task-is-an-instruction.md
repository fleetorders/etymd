---
"etymd": minor
---

`etymd premise "<task>"` — the task you hand an agent is an instruction too. Every path, script,
well-known doc and decision id the task names is verified against the repo (a missing thing the
task is _about_ ranks as risk), and a brief hands the agent the premises only it can verify.
`--file`, `--json` (schema `premise/1`), `--no-brief`, `--fail-on <tier>`. Zero trace in a repo that
never opted in; no ledger. The command/path/doc-reference truth checks are now one shared
implementation used by `instruction-truth` and `premise` alike — ids, tiers and disclosures of
existing findings are unchanged.
