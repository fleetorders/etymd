---
"etymd": minor
---

`etymd gates` no longer writes a gate that cannot fail. It derives whether any risk-tier finding is
reachable in the repo (a package manifest to contradict, a state document to fall behind); where
none is, the generated hook drops to `--fail-on gap` and the output says so and why. A `failOn`
recorded in `.etymd/config.json` is never adjusted, and `gates` now states which tier it wrote and
where that tier came from — the config key was previously unmentioned anywhere in its output.
