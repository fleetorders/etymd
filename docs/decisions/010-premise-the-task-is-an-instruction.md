# 010 — The task is an instruction: `etymd premise`

Scope: etymd — the objective's boundary, the `premise` command, and the shared truth checks.

_Status: implemented._

## Why

003 locked one objective: **keep your agent instructions true**, and read "instructions" as the
files — AGENTS.md, CLAUDE.md, rules, skills. That reading was right for what it excluded (setup
adapters, maturity scores, per-agent pointers) and too narrow for one thing it never considered:
the task itself.

A recurring failure of agent-driven work is not a bad answer but a **false premise**: the task
names the file to improve, and it is not the affected file; the task asks to make a feature
behave better in one situation, and the feature never worked at all, so the whole question sits
downstream of a defect the task does not mention. The agent answers the question as asked — the
wrong problem, solved precisely — and the error surfaces late, if at all. A premise check belongs
before the plan, and a failed premise outranks every other finding.

That check has two halves. One half is **reading files**: does the path the task names exist, does
the script it wants run exist, does the decision it cites exist. That half is exactly what etymd
already does for instruction files, with precision rules that took months of corpus work to get
right. The other half — is the named file the one _meant_, does the assumed mechanism actually
run, does the assumed state hold — needs an agent, and etymd does not run agents (005: anything
beyond reading files is out of scope by construction).

## The objective, widened by one notch

> **Keep your agent instructions true** — where an instruction is anything told to an agent, in a
> file or in the prompt.

Nothing else moves. The files remain the primary surface, drift and the ledger remain the product's
continuous half, and 003's cut list stays cut. The task is admitted because it is the same kind of
thing the files are: text an agent will act on, making claims about the repo that can be checked
before it does.

## What `premise` does, and refuses

`etymd premise "<task>"` (or `--file`) runs the shared truth checks over the task text and writes a
brief.

- **Checked, deterministically:** paths, package-script invocations, well-known doc mentions,
  `D-NNN` decision ids. People do not backtick paths in a prompt, so bare mentions are promoted
  into code spans first — but the extractors' precision came from the backtick being the author's
  deliberate signal, and prose offers no such signal. Manufacturing it from a sentence and reusing
  the code-span filters as-is accuses ordinary prose: a package manager named before any noun
  ("the pnpm monorepo", "bun will …"), a slash-joined phrase with a trailing slash
  (`input/output/`), a URL with its scheme dropped (`github.com/org/repo/…`) — each a RISK, each
  false. So prose promotion is stricter than the extractor: a path needs a directory AND a
  recognized extension; a directory claim needs its trailing slash AND a first segment that
  exists here; a script needs the `run` form (or `npm test` / `npm start`) — a bare `pnpm X` in
  a sentence is a phrase as often as an invocation; a first segment shaped like a host name is a
  URL. Everything backticked is read exactly as an instruction file would be — with one
  task-surface exception: a mention behind a namespace prefix (`pc:`, `lk:`, a repo shorthand)
  points into another repo's tree, not this one. Every class left as
  prose is counted and disclosed, never silently dropped — the same skip-class discipline as the
  file lens. And a missing path is only accused when it is plausibly repo-relative at all: its
  first segment must start where a directory of this repo does. A task routinely quotes paths
  from OTHER repositories (a clone in a scratchpad, a legend-prefixed token); absence of such a
  path here proves nothing, and calling it "missing in the repo" was a live false positive that
  outranked the task's real content.
- **Handed over, never guessed:** the three semantic premises, in `.etymd/premise-brief.md`
  (only where `.etymd/` exists — a repo that never opted in takes zero writes and gets the brief on
  stdout). The brief lists what was checked, found or not, then the questions only an agent can
  answer, and tells it to report a failed premise first.
- **Refused:** running anything; calling a model; remembering task findings between runs (no
  ledger — a task is not a document that drifts); a prompt hook that checks every prompt (a pack
  change, deferred until the command has earned it by use).

## One deliberate departure from 009's tiering

009 ranks a dead path in an instruction file as `gap` — one dead reference among many. `premise`
ranks a dead path the task names as **`risk`**. The surface differs: an instruction file
_mentions_ a path in passing; a task is _about_ it. An agent acting on "fix the flaky test in
`src/legacy/foo.test.ts`" when that file does not exist does the wrong thing with high confidence,
which is the definition of `risk`. It also makes `--fail-on risk` a usable gate for the case the
command exists for.

## The fitness test, answered (005)

`premise` is a command, not a predicate, but the discipline is the same and the answers are on
record:

1. **Would a user who is not us ask for it?** Anyone pasting a task into a coding agent that then
   confidently edits the wrong file. The failure is common enough to have a folk name — "solving
   the wrong problem precisely."
2. **Is it a question about repository state?** Yes, entirely — the semantic half is explicitly
   handed off, not answered.
3. **Does it compose?** It is the existing checks over new input; the checks were factored into
   one implementation (`checks.ts`) so the file surface and the task surface cannot drift apart.
4. **Is it already expressible?** No — nothing accepts text that is not a file in the repo.
5. **What does its absence cost?** The check that becomes impossible is "before I hand this over,
   does what it names exist" — which is the single cheapest thing that would have caught both
   failures above.

## What changed

- `src/lenses/instruction-truth/checks.ts` — the command, path, doc-reference, and
  decision-reference truth checks, factored out of the lens with tier and wording as parameters
  and the rules shared; each returns what it examined beside what it flagged. `instruction-truth`
  calls it for files and state documents; ids, tiers, and disclosures are unchanged.
- `src/engine/premise.ts` — prose promotion with its own skip classes, the checks over the task,
  the entity list (the checks' own examined lists — never a second extraction), the brief.
- `src/commands/premise.ts`, `src/cli.ts` — the command: `--file` (`-` reads stdin, so a hook or a
  pipeline needs no temp file), `--json` (schema `premise/1`), `--no-brief`, `--fail-on <tier>`.
- README, `docs/usage.md`, `AGENTS.md`, `ROADMAP.md`, `package.json` — the objective's wording
  widened everywhere it is stated; 003 carries a forward note.
