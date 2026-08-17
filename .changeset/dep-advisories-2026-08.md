---
"etymd": patch
---

Dependency advisories, 2026-08 batch: vitest 2.1.8 → 2.1.9, @changesets/cli 2.27.11 → 2.31.1,
tsup 8.3.5 → 8.5.1, plus in-range transitive fixes (js-yaml, nanoid, postcss, tmp)

Clears every advisory reachable without a semver-major bump. What remains is one class —
esbuild/vite/vitest development-server exposure (a listening dev server can be made to read or
execute files) — and its only fix path is vitest 2 → 4, a breaking migration deliberately not
taken in this batch. Exposure here is nil in practice: `vitest run` and the build never start a
listening server, so the vulnerable code paths are never entered. Left for a deliberate
migration, not an audit-chased one.
