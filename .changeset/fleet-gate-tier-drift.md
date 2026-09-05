---
"etymd": patch
---

The fleet's gate-drift check now derives the pre-push audit tier the same way `etymd gates`
does. In a repo where no risk-tier rule can fire (no package manifest, no state doc) the
generator lowers the audit line to `--fail-on gap`; the drift comparison planned with the raw
config tier (`risk`), so its expectation permanently differed from the hook the generator
itself writes — a `gate-stale` finding on every repo of that shape, unclearable by the action
it names. The derivation now lives in `planWorkflow` itself, where the hook is built, so every
caller (the drift check, `etymd init`, the programmatic surface) generates identical bytes; a
tier the repo pinned in config is still never lowered.
