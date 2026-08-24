---
"etymd": minor
---

A content gate that cannot run is now caught, and says why.

The screen doors resolve their checker at run time, from outside the repo — so whether the gate
will actually run is the one thing reading the hook cannot tell you. When the resolved checker
turns out not to be a screener, the commit door failed closed on that program's own bare error
and the push door, advisory by design, skipped its whole-tree pass in silence. A repo could read
as screened for months while nothing screened it.

Two changes, one class:

- **The hooks explain themselves.** After a failed screen — and only then, so a clean run pays
  nothing — the hook asks the checker whether it understands `screen` at all. If it does not, it
  prints a line naming the version floor (`screen` needs etymd 0.11+) and the override, instead of
  leaving the checker's unexplained "unknown command" as the last word. A screener reporting a
  real finding is left to speak for itself.
- **`etymd audit` and `etymd doctor` check reachability.** Gate integrity now resolves the screen
  runner exactly as the hook would and asks it the same question, reporting a risk-tier finding
  when a checker resolves but cannot screen. No checker installed stays the designed no-op —
  disclosed, never a finding — and a probe that could not be carried out claims nothing.
