# 008 — The generated gate derives its tier, and always says where the tier came from

Scope: etymd — `etymd gates`, the pre-push tier, and `gates.failOn` in the config file.

_Status: implemented._

## The gate that cannot fail

The generated `pre-push` hardcoded `etymd audit --fail-on risk`. In a repo with no package
manifest and no state document, no risk-tier rule has its preconditions: the line exits 0 on every
push, and nothing in the output distinguishes it from a working gate. That is the failure this
tool exists to catch, wearing the tool's own clothes — worse than no gate, because a green push
reads as evidence.

It is also self-concealing twice over. The reverting change is a diff in a generated file, which
nobody reads as policy; and the only signal that anything is wrong is a tier word buried in a hook.
The shape that motivated this: a repository measures its own tier, records a lower one, and a later
regeneration reinstates the default — after which every subsequent regeneration faithfully
reproduces it, the pushes stay green, and the decision record goes on stating the tier the repo
believes it enforces.

## Reachability is derived, and the derivation is stated

`gates` now computes which risk-tier audit findings could fire in this repo before it writes the
hook:

- a package manifest exists ⇒ an instruction file can name a script that no longer resolves;
- a state document exists ⇒ it can fall far enough behind the repo to escalate to risk.

`gate-integrity/hooks-not-wired` is excluded by construction: it fires when `core.hooksPath` is
unset, and a pre-push hook cannot run in that state.

Where nothing is reachable, the derived tier drops to `gap` — the next tier this repo can actually
reach — and the output says the tier moved and why. Where something is reachable but the tier is
`risk`, the output names what can fire, which is what makes a too-narrow tier visible at the moment
it is chosen rather than six days later.

The derivation is deliberately conservative in one direction: a rule whose preconditions are
uncertain counts as reachable. Both mistakes are wrong, but only one of them can be caught by
reading the output — wrongly claiming a gate works is the original defect wearing the other face.

## A recorded tier is a decision; a default is not

`deriveFailOn` may only adjust a tier that came from the default. A `gates.failOn` written into
`.etymd/config.json` is never touched, which required the loader to report which keys the file
actually set — the resolved value cannot distinguish a deliberate `risk` from an absent one, since
they are the same word.

That asymmetry is the whole point of the record. The reverting regeneration was a generator
overwriting a decision with a default; a generator that may only choose between defaults cannot
repeat it.

## Provenance travels with the tier

`gates` never prints the tier alone any more — before the install and again beside the written
hook, it says which tier it wrote and whether that came from the config file, a derivation, or the
default, and names `gates.failOn` as the durable home. The config key was previously unmentioned at
any point in the command's output, while `gates` refuses to overwrite an existing hook: a hand-edit
to the hook looked like it worked and then silently lost on the next regeneration from a clean
tree. Naming the key in the output puts the correct fix in front of the reader at the moment the
wrong one is tempting.
