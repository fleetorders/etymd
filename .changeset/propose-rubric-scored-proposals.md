---
"etymd": minor
---

`etymd propose` — score the sweep's improvement findings and recurring classes against a
fleet-authored rubric file (`criterion: <weight>` labeled lines; criteria: severity, economy,
confidence, breadth — an unknown criterion is refused quoting the line) and emit deterministic,
read-only `proposal/1` records carrying score, the fired rubric lines, and an implications block
(projects, files, gates, reversibility) extracted from finding evidence. Guarded entries are
excluded from the output entire. `--manifest` (fresh read-only sweep) or `--from <fleet.json>`
(stored sweep), `--json`. Decision record: docs/decisions/012.
