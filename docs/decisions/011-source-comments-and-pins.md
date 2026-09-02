# 011 — Source comments and dependency pins: the checks widen, not multiply

Scope: etymd — the truth surface's file set, the pin checks, and the offline constraint.

_Status: implemented._

## Why

010 read "instructions" as anything told to an agent, in a file or in the prompt — and the file
half still meant the instruction layer: `listInstructionFiles` collects AGENTS.md, CLAUDE.md,
rules, skills. Source code was out of scope entirely, so a claim written in a comment was never
checked. That is the larger half of the tool's own thesis: the README argues a written rule "never
complains when it goes stale", and a comment is a written rule that happens to live in a `.ts`
file.

The evidence that motivated this, measured on a repo of the validation corpus: decision
references in comments outnumbered every other checkable class by an order of magnitude,
against an in-repo `DECISIONS.md` — the one claim class etymd already knew how to verify,
present in bulk, checked by nothing. Renumber or supersede an entry and the code silently lies.
The same repo measured no TODO/FIXME/`@ts-ignore` rot at all — the generic "stale TODO" pitch
is not what motivates this, which is why the decision reference leads and no TODO checker ships
here.

The second half is the same shape one layer down the manifest: pins (`overrides`,
`resolutions`, `patchedDependencies`) are claims about the tree that rot the same way — the
dependency moves on, the pin stays, and every reader reconstructs a constraint that no longer
binds.

## What shipped

1. **`comment-truth`** — the four existing checkers (script, path, doc, decision) over source
   comments. No new claim kinds, no new verification logic: comment text is promoted with the
   premise surface's stricter prose rules (`promoteBareTokens`) and run through the shared
   `checks.ts`, so a third copy of the precision rules cannot drift in beside the two that exist.
   Extraction is per language and string-aware — misreading string content as a comment would
   manufacture claims, the exact false-positive class this tool exists to avoid; misreading a
   comment as code only loses one. Findings name the file and line; many comments citing one dead
   reference collapse into one finding with example lines.
2. **`pin-integrity`** — lockfile arithmetic, nothing else: an override whose package nothing
   requests any more, a patch whose target version the lock no longer carries. Both answerable
   with zero registry calls.

## Tiers

A dead command in a comment is **risk**, same as in an instruction file — an agent reading the
code follows comments just as it follows the contract, and the check it describes is silently
skipped when the script is gone. Paths, doc references, and decision ids are **gap** — a comment
mentions them in passing; 009's instruction-file logic applies rather than 010's task logic (a
comment is never _about_ the path the way a task is). Dead pins are **gap** with medium
confidence: the arithmetic is certain given the lockfile, and the lockfile is the thing most
likely to be stale.

## Skip classes (counted, disclosed, never silently dropped)

- Test, fixture, mock, and vendor files — their comments deliberately name paths that do not
  exist. Also reported `outOfScope` so the ledger holds any tracked finding inside them open:
  unexamined is not fixed.
- Mixed-language templates (`.vue`, `.svelte`, `.astro`) — no single comment grammar covers them.
- The premise surface's prose classes carry over (bare `pnpm X` phrases, host-shaped tokens,
  unrooted trailing-slash phrases, `… run <function word>`), plus the shared command/path
  classes (uninstalled `node_modules`, gitignored claims, create-this prose, stand-ins).
- Pin shapes offline arithmetic cannot judge: no lockfile at all, nested-path override keys
  (`foo>bar`), range selectors (`name@range` — verified by name only; range intersection is not
  done offline). The committed lockfile is stated as the universe of the judgment, including its
  staleness caveat.

## Constraints that hold

- **Offline.** Four dependencies, zero `fetch`, zero model calls — pinned by a test that scans
  `src/` for network calls, so the constraint survives this change instead of being re-asserted
  per feature.
- **Precision over recall.** String-aware extraction; promotion stricter than the extractor;
  name-only verification for range pins; unverifiable is a disclosure, never a guess.
- **No project names in the shipped package.** Fixtures describe shapes (`src/app.ts`,
  `shape-demo`), never the repo the evidence came from.

## The fitness test, answered (005)

These are native lenses, not declared-rule predicates, but the discipline is the same and the
answers are on record — for each shipped surface:

1. **Would a user who is not us ask for it?** Any maintainer who renames a script or renumbers a
   decision record and wonders what still points at the old name; anyone who removed a dependency
   and wants to know whether the override left behind still claims to bind anything.
2. **Is it a question about repository state?** Yes, entirely — comments, manifests, lockfiles.
   No tool run, no network, no clock beyond the lockfile as committed.
3. **Does it compose?** The comment surface is the existing checks over a new file set plus one
   extractor; the pin checks are three manifest shapes against three lockfile shapes, table-driven.
4. **Is it already expressible?** No — nothing scanned comments or pins.
5. **What does its absence cost?** The check that becomes impossible is "does anything in this
   repo still cite the decision I am about to delete" — the single cheapest thing that would have
   caught the motivating case — and, for pins, "does this override still bind".

## Deliberately parked (not designed here)

- Checks needing a tool run: an `eslint-disable` that suppresses nothing, an `@ts-expect-error`
  that types no longer object to (TypeScript's own instance of this idea — it needs no help).
- Opt-in network probes behind a flag, default off: "upstream shipped a fix" (registry), "that
  issue is closed" (hoster API).
- Semantic claims ("safe because the caller validates") — the only tier where a model earns its
  place, and which must never be able to fail CI.

## What changed

- `src/lenses/instruction-truth/comments.ts` — per-language, string-aware comment extraction.
- `src/lenses/comment-truth.ts` — the lens: tracked source files, promotion, the shared checks,
  per-file dedupe with line evidence, skip-class disclosures, out-of-scope reporting.
- `src/lenses/pin-integrity.ts` — pin parsing (`foo`, `@scope/foo@range`, glob-prefixed,
  patch-target both directions) and lock indexing for pnpm/npm/yarn lockfiles.
- `src/engine/run.ts` — both lenses registered.
- `src/engine/premise.ts` — `listRootedDirs` exported for reuse (the comment surface needs the
  same rooted-directory guard prose promotion uses).
- Tests: `test/comment-truth.test.ts` (extraction units, the lying-fixture/clean-fixture pair,
  dedupe, skip classes, offline-by-construction) and `test/pin-integrity.test.ts` (parsing units,
  dead override, manifest-requests-override, both patch directions, workspace-yaml patches, yarn
  resolutions, selector disclosure).
- README, `docs/usage.md`, `AGENTS.md`, `ROADMAP.md` — the widened surface documented.
