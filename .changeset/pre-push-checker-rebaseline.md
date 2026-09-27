---
"etymd": patch
---

Generated pre-push re-baselines when the shellcheck binary changes. A new checker release
can flag scripts already sitting on the remote, and the per-commit read only re-reads what a
commit touches — those findings waited for each script's next edit. The hook now stamps the
checker's version inside the git dir (never the working tree, so no repo grows an untracked
file for bookkeeping) and checks every commit of a push whole on the first push after the
version moves, saying so in its output; the stamp is rewritten before the checks run, so an
interrupted push cannot re-trigger the re-baseline. The commit's `.shellcheckrc` travelling
with the materialised tree (the scratch checkout writes every tracked blob) is now pinned by
a real-shellcheck test: a config-only change is honoured without touching scripts.
