---
"etymd": minor
---

Generated hooks no longer guess at the content screener by path.

The emitted content-screen resolution used to include a bare `[ -x ./dist/cli.js ]` check ahead
of the `etymd` on PATH. That path is simply where a great many CLI projects build, so any repo
that builds its own binary there had the hook invoke THAT binary as the screener: it does not
know `screen`, so the commit door failed closed on every commit, while the push door — which
ignores the screen's exit status by design — skipped the whole-tree pass in silence. The trap
armed itself on a plain dependency install, since that runs the repo's build.

Resolution is now `CONTENT_GATE`, then whatever `etymd` is on PATH. The dev-build arm remains
for the repo that develops the screener itself, where gating on an unreleased build is the point,
but it is decided at generation time from the manifest name and emitted nowhere else.

Regenerate with `etymd gates` to pick this up; a repo needing a different runner for one
invocation still has `CONTENT_GATE`.
