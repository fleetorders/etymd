---
"etymd": minor
---

screen: the machine-path check now also skips on upstream-owned files

The upstream-ownership exemption (0.12.0) skipped vocabulary-class patterns on files
byte-identical to public upstream, but the absolute-home-path check still fired on
them. Forks of container-based projects carry upstream docs full of generic container
paths (the `/home/<user>/...` shape), so a sync kept blocking on paths that are
already public in the upstream repo and never name the local machine.

An upstream-owned file is byte-identical to a public upstream blob, so any path it
names is already public and cannot leak this machine. The machine-path check is now
skipped for upstream-owned files, exactly like vocabulary-class patterns. Secret-class
patterns stay absolute on every file, and the machine-path check still fires on all
non-upstream files (the common case) unchanged.
