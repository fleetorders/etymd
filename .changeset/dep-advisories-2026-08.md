---
"etymd": patch
---

Dependency advisories, 2026-08 batch: vitest 2.1.8 → 4.1.10, @changesets/cli 2.27.11 → 2.31.1,
tsup 8.3.5 → 8.5.1, plus in-range transitive fixes (js-yaml, nanoid, postcss, tmp)

Clears the whole advisory list reachable in range, then the vitest 2 → 4 major the rest of it
needed — the deliberate migration, not an audit-chased one: all 260 tests pass on 4.1.10
unchanged, config needed nothing, and the esbuild/vite/vitest development-server exposure class
(file read and execution via a listening dev server) is closed rather than reasoned around.

What remains is one low: esbuild 0.27.3–0.28.0, arbitrary file read when running a development
server on Windows, reached only through tsup (which pins ^0.27.0). Forcing an override past
tsup's declared range is audit-chasing a code path this repo never enters — nothing in it
starts a listening dev server — so it waits for a tsup release that carries esbuild 0.28.
