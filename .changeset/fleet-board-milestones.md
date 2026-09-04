---
"etymd": minor
---

`contract.milestones` and `etymd fleet board` — a project declares its plan in `MILESTONES.md`
(`# Milestones`, then `| id | milestone | goal | status | next | effort | depends-on |`); the sweep
files a gap when a declared file is absent or off-shape; `fleet add` registers the file when
present; `fleet board --initiatives <file> --out <file>` renders every project's rows plus a ranked
initiatives table and totals, deterministic, guarded entries excluded, exit 1 on holes.
