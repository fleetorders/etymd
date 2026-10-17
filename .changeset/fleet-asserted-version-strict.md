---
"etymd": patch
---

A fleet manifest's asserted Claude Code version is parsed strictly — a `X.Y.Z` triple plus
an optional prerelease suffix — and judged as given, instead of running the lenient triple
extraction meant for pins and probe output. `2.1.277-rc1` used to trim to `2.1.277` and read
as current; glued garbage passed as a version. Now a prerelease of the fallback reads old,
and a string that is not a version establishes nothing and reads as undetermined — the
fail-closed answer that kind exists for. Pins and probe output keep their lenient
extraction.
