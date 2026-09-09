---
"etymd": patch
---

Dependency audit: js-yaml 4.3.1 → 4.3.2 and 3.15.1 → 3.15.2 (both dev-only, transitive —
via changesets and read-yaml-file) to clear GHSA-2883-xcg3-v3hh (high: `maxTotalMergeKeys`
does not limit CPU use for empty merge sources). Lockfile only; no direct dependency
changed. etymd never parses untrusted YAML at runtime, so the advisory's practical exposure
here was nil — the bump is hygiene.
