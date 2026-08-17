---
"etymd": patch
---

Content screen: a clean run reports itself, with the file count

A clean `etymd screen` printed nothing at all — the summary header, file count and binary-skip
count only appeared when there were findings. From inside a hook, where the exit code is the
only other signal, "silent" and "never looked" were indistinguishable, which is the exact
failure the binary-skip disclosure exists to prevent (0.9.1 claimed the count is always
reported; on a clean run it never was).

Every run now prints its summary line — scope, files scanned, binary skipped — and a clean run
says so. Hooks gain one line per successful commit; a silent screen remains possible only
where the screener is absent, which the tool already reports as inert rather than clean.
