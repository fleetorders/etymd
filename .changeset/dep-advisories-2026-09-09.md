---
"etymd": patch
---

Dependency advisories cleared inside the declared ranges. `vitest` 4.1.10 → 4.1.11 closes
GHSA-82fw-gwwq-j7x9 (moderate: path traversal / arbitrary file read through the `@vitest/mocker`
redirect mock), and `js-yaml` 4.3.1 → 4.3.2 with its transitive 3.15.1 → 3.15.2 closes
GHSA-2883-xcg3-v3hh (high: `maxTotalMergeKeys` does not limit CPU use for empty merge sources).
Both are dev-only — the test runner and the changeset tooling — so the published build is
byte-identical; the lockfile also picks up the range-satisfying refresh those two pull in.

One advisory stays open, and deliberately: GHSA-g7r4-m6w7-qqqr (low: `esbuild` allows an arbitrary
file read when its development server runs on Windows) is fixed in esbuild 0.28.1, while `tsup`
8.5.1 — the newest release — declares `esbuild: ^0.27.0`, so no in-range version of esbuild carries
the fix. The only automatic fix on offer is a downgrade to esbuild 0.27.2, which gives up five
patch releases to dodge a dev-server path this repo never takes: the build runs tsup, never an
esbuild server. It clears once tsup widens its range.
