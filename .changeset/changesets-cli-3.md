---
"etymd": patch
---

The release tooling moves to @changesets/cli 3.0.3. The 2.x line pulled in braces, which carries
a denial-of-service advisory (GHSA-vfj7-8cjw-p6xm) with no patched release; 3.x no longer depends
on it. It is a development-only dependency, so nothing changes for anyone installing etymd.
