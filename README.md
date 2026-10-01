# Etymd

<div align="center">
  <img src="https://raw.githubusercontent.com/fleetorders/etymd/main/media/etymd-logo.png" width="520" alt="Etymd: a papyrus of written instructions, each line checked against the repository it describes">
  <p>
    <a href="https://www.npmjs.com/package/etymd"><img src="https://img.shields.io/npm/v/etymd.svg?label=npm&color=cb3837" alt="npm version"></a>
    <a href="https://github.com/fleetorders/etymd/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fleetorders/etymd/ci.yml?branch=main&label=CI" alt="CI"></a>
    <a href="https://github.com/fleetorders/etymd/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  </p>
</div>

**Keep your agent instructions true.**

You wrote rules for your AI months ago. Since then a script got renamed, a folder moved, a habit
changed, and the AI still trusts every word. The file never complains when it goes stale; it just
keeps instructing, confidently, and you live with the results.

Etymd reads those instruction files (and, when you ask, the task you are about to hand an agent)
and checks every claim against your actual project.

One command, run in your project's folder (needs Node ≥ 18.17, nothing else): `npx etymd audit`.
Here it is on a small demo project whose AGENTS.md still tells the AI to run `npm run start` and
`npm run lint` and points at a `src/legacy/` folder, none of which exist any more:

```
$ npx etymd audit

  RISK   AGENTS.md tells agents to run `start` — no such script exists
         evidence  AGENTS.md: `npm run start` · package.json scripts (root + workspaces)
         why       An agent following this instruction runs a command that fails — or silently skips the check it was meant to run.
         action    Update the instruction to the current script name (or restore the script).
         effort S · confidence high · instruction-truth · instruction-truth/stale-command:AGENTS.md:start

  ...

  GAP    AGENTS.md references `src/legacy` — it does not exist in the repo
         evidence  AGENTS.md · missing: src/legacy
         why       Agents navigate by these references; a dead path wastes a lookup and erodes trust in the rest of the file.
         action    Fix or remove the reference.
         effort S · confidence medium · instruction-truth · instruction-truth/stale-path:AGENTS.md:src/legacy

  since last audit: 3 still open
```

Each entry names something that is no longer true, shows the evidence it found, and suggests the
smallest fix. And it remembers between runs: a problem you fixed, or looked at and deliberately
waved off, never nags you twice.

That's the whole deal. It works with zero configuration and never rewrites your files; the
memory it keeps between runs lives in one small folder of its own (`.etymd/`). Everything below
the line is reference.

_From Greek **étymon**, a word's true, original sense (hence etymology), clipped to **etym.** +
the **.md** family it guards._

---

## Why this exists

- **Truth is a property over time, not a point in time.** Instruction files are load-bearing now:
  coding agents (Claude Code, Codex, Cursor, Copilot, Gemini, …) read `AGENTS.md` natively, and a
  stale claim doesn't error, it silently misleads every session. Linters for these files check a
  moment; Etymd measures _drift_ against a committed _baseline_ and remembers findings in a
  _ledger_, so fixed things stay fixed and a returning problem is named a _regression_ (all four
  words defined just below). It runs when you invoke it, or when a hook or CI job you wire up
  does.
- **Honesty is structural.** Every report declares what it could NOT see: CI jobs inherited from
  unreadable org templates, server-side quality-gate thresholds, heuristics it skipped. No guess
  is ever dressed as a fact.
- **Precision over recall.** A false "your file is lying" costs more trust than a missed lie, so
  the checks filter aggressively, and every class of claim they skip is counted and disclosed,
  never silently dropped.

## The words Etymd uses

| The docs say                   | It means                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **finding**                    | One verified problem, ranked **RISK** (an agent acting on this does the wrong thing) → **GAP** (a dead reference or missing safeguard) → **POLISH** (worth tidying). Within a tier, cheapest fix first.            |
| **claim**                      | Anything an instruction file asserts about the project that can be checked: a command it tells agents to run, a path it points at, a rule about tooling.                                                           |
| **lens**                       | One self-contained checker for one kind of truth (are the commands real? is the state doc current?). An audit is all lenses run together.                                                                          |
| **reckoning**                  | The deterministic scan of the repo's checkable facts: package manager, scripts, hooks, CI, instruction files, layout. `etymd scan` prints it; everything else reads it.                                            |
| **baseline**                   | A reckoning you approved and committed. Drift is measured against this, not against whatever yesterday's cache happened to hold.                                                                                   |
| **drift**                      | The distance between the baseline and the repo today: what existed at approval and is now gone, renamed, or moved.                                                                                                 |
| **ledger**                     | The committed memory of findings, each one's status and history. A finding that was fixed and comes back is a **regression**, and the report names it as one rather than re-introducing it as new.                 |
| **dismiss vs accept**          | Two deliberate ways to close a finding. _Dismiss_ = "not a real problem, here's why"; it never resurfaces unless it regresses. _Accept_ = "true, and we're living with it"; kept in the ledger, out of the report. |
| **gate**                       | A check that can actually fail a change: a git hook, a CI job. A job marked `allow_failure` is advisory, not a gate; a check that cannot fail anything is an opinion.                                              |
| **stale / edited / unstamped** | The three states `etymd gates` reports for a hook it generated earlier: the templates moved on (regenerate), you changed it (keep, and say so), or it predates the stamp (keep, and say why).                      |
| **disclosure**                 | The report's account of what it could not see or refused to guess about. Every report carries one; a clean result with no disclosures would be the exact dishonesty this tool exists to catch.                     |
| **fleet**                      | Your fleet of **repositories**: every repo you registered in one manifest, swept by one command. Not a fleet of AI agents.                                                                                         |
| **guarded**                    | A manifest entry whose real path never appears in a tracked file and into which the tool never writes. The other profile is `personal`.                                                                            |
| **context economy**            | The words your instruction files load into every single session, measured against a budget. Context is a cost you pay per conversation; leaner files are cheaper and better obeyed.                                |

### Things that surprise first-run users

- **"It missed an obvious stale command."** Without `node_modules` installed, command claims are
  skipped, and the skip is disclosed in the report. A command might resolve to an installed
  binary, and Etymd would rather say "couldn't check" than accuse an honest file. Install
  dependencies and run again.
- **`etymd audit` works without `etymd init`.** You only lose drift-over-time measurement: with
  no committed baseline, there is nothing to measure drift against. Everything else runs.
- **`etymd init` never overwrites an existing `AGENTS.md`.** It scaffolds a minimal one only if
  you have none.
- **"The shellcheck step announced that it skipped."** That is the intended behaviour: where the
  binary is absent the hook says so and names the install command, because a check that goes
  quiet when its tool is missing looks installed everywhere and is installed nowhere.

---

## Quick start

```bash
cd your-project
npx etymd audit         # verify every instruction claim against the repo
npx etymd init          # opt in to drift: approve the baseline (+ scaffold AGENTS.md only if you have none)
npx etymd audit --fail-on risk   # the CI gate
npx etymd premise "fix the flaky test in src/legacy/foo.test.ts"   # is this the right task?
```

`audit` needs no setup; without `init` you get the full findings report and lose only drift
measured against a committed baseline. `init` is that opt-in, not a prerequisite, and it never
overwrites an existing `AGENTS.md`. To wire the gate into a pipeline, see
[gates](https://github.com/fleetorders/etymd/blob/main/docs/gates.md).

## What it checks

**`instruction-truth`**, over `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Copilot instructions,
`.cursor/rules/*`, `.clinerules`, `.claude/skills/*/SKILL.md`:

- **Command claims**: every `pnpm X` / `npm run X` the files tell agents to run must exist in
  `package.json` scripts.
- **Path claims**: every repo path the files point at must exist (conservative heuristics; what's
  skipped is disclosed). A path the surrounding prose tells the agent to _create_, and an obvious
  naming stand-in like `my-custom-skill`, are forward-looking instructions, not stale references.
- **Package-manager consistency**: instructions must not command `yarn` in a `pnpm` repo.
- **Cross-references**: pointer chains (`CLAUDE.md` → `AGENTS.md` → state docs) must resolve.
- **Drift vs baseline**: documented commands, artifacts and layout that existed at approval and
  are now gone.

**`premise`** (via `etymd premise`): the task itself is an instruction. Before an agent acts on
it, every path, script, well-known doc and decision id the task names is checked with the same
rules instruction files get. A path the task is _about_ and that does not exist ranks as **risk**:
the task would solve the wrong problem precisely. What cannot be read from files (that the named
things are the ones meant, that the mechanism the task assumes actually runs, that the state it
assumes holds) is handed to the agent in a brief, never guessed at. Nothing is remembered between
runs.

**`gate-integrity`**: a CI config is a claim too. Checks enforced only in CI (the failure shows
up after the agent finished; `etymd gates` generates the local mirror), checks only in skippable
local hooks, latent gaps (coverage collected but nothing gates on it; commitlint installed but
unwired). `allow_failure` jobs count as advisory, never as gates.

**`context-economy`**: the always-loaded footprint in words/tokens (only genuinely
`alwaysApply` Cursor rules count), flagging files worth extracting into on-demand skills.

**`state-freshness`**: the layer that claims "this describes now" (`PROJECT_CONTEXT.md`,
`DECISIONS.md`, ADR directories), judged by git committer dates only, never mtime. Staleness is
_relative_: a state doc is stale only when the repo moved past it, so a dormant repo's old state
is current, and a tracked file with uncommitted edits is treated as fresh now and disclosed.
Decisions records get format checks (`Scope:` presence, a `Revisit:` date that, once past,
becomes a finding) when you opt in with the marker `<!-- decisions-format: 1 -->`; append
`fields=Owner,Rollback` to require fields of your own, checked for presence only. Duplicate or
out-of-order `D-NNN` ids are flagged even without the marker.

**`fleet-manifest`** (via `etymd fleet`): one truth guard across every repo you registered,
per-repo audits plus checks on the manifest itself and on its own entries. See
[the fleet manifest](https://github.com/fleetorders/etymd/blob/main/docs/fleet.md).

## Commands

| Command                          | What it does                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `etymd audit`                    | Verify every claim; ranked findings (risk → gap → polish) + ledger diff. `--lens`, `--truth`, `--json`, `--no-ledger`, `--fail-on <tier>`.                                                                                                                          |
| `etymd init`                     | Onboard: approve the committed baseline; scaffold a minimal AGENTS.md **only if missing**, with its `CLAUDE.md` pointer. Never overwrites.                                                                                                                          |
| `etymd doctor`                   | Alias for `audit --truth`.                                                                                                                                                                                                                                          |
| `etymd context`                  | The economy view: per-file always-loaded footprint + extraction candidates.                                                                                                                                                                                         |
| `etymd gates`                    | Install local git-hook gates (pre-commit / commit-msg / pre-push, plus a publish screen where something ships) built from your own check scripts, and from the repo's shell scripts where it has any.                                                               |
| `etymd screen`                   | Content screen: find text that must never be published. Four scopes: `--staged`, `--message`, `--tree`, `--dir`. Bring your own patterns; etymd ships none.                                                                                                         |
| `etymd scan`                     | The reckoning behind everything. `--json`.                                                                                                                                                                                                                          |
| `etymd brief`                    | A grounded briefing your in-repo agent completes to author the semantic layer.                                                                                                                                                                                      |
| `etymd premise`                  | `premise "<task>"`: is this the right task? What it names, verified against the repo; a brief for what only the agent can verify. `--file` (`-` = stdin), `--json`, `--no-brief`, `--fail-on <tier>`. No ledger.                                                    |
| `etymd approve`                  | Refresh the committed baseline non-interactively after intentional structural changes.                                                                                                                                                                              |
| `etymd ledger`                   | The findings memory: every tracked finding with status and history.                                                                                                                                                                                                 |
| `etymd dismiss`                  | `dismiss <id> --reason <text>`: a dismissed finding never resurfaces without regressing.                                                                                                                                                                            |
| `etymd accept`                   | `accept <id>`: record a finding as accepted reality; visible in the ledger, out of the report.                                                                                                                                                                      |
| `etymd fleet`                    | Sweep every project in a fleet manifest: read-only per-repo audits + the manifest's own checks. `--manifest`, `--only`, `--profile`, `--truth`, `--persist-ledgers`, `--json`, `--fail-on`.                                                                         |
| `etymd fleet check`              | Validate the manifest pair alone (no lenses): dangling mappings, duplicate names, privacy leaks, undeclared trust, machine paths. Non-zero exit on any finding.                                                                                                     |
| `etymd fleet add`                | `add <dir>`: register a project. Scans it, asks for what no scan can derive, and refuses to write an entry missing a mandatory field, or a repo whose `AGENTS.md` Claude Code cannot see. `--name`, `--kind`, `--profile`, `--trust`, `-y`.                         |
| `etymd fleet board`              | Render the fleet board: every project's `MILESTONES.md` (contract key `milestones`, shape-checked by the sweep) plus a ranked initiatives table on one page. `--initiatives <file>`, `--out <file>`, `--json`.                                                      |
| `etymd propose`                  | Score the sweep's improvement findings + recurring classes against a rubric file you author: stable `proposal/1` records, read-only, deterministic, guarded entries excluded. `--rubric <file>` (required), `--manifest <file>` or `--from <fleet.json>`, `--json`. |
| `etymd fleet dismiss` / `accept` | `<name> <id>`: resolve a project's finding from any cwd; guarded findings persist beside the manifest, never in the guarded worktree.                                                                                                                               |

`--cwd <dir>` targets another directory. Read-only probing of any repo leaves **zero trace**
(`audit --no-ledger` writes nothing).

The reference docs:

- [usage](https://github.com/fleetorders/etymd/blob/main/docs/usage.md): every command and lens in more depth.
- [configuration](https://github.com/fleetorders/etymd/blob/main/docs/configuration.md): the files Etymd keeps and `.etymd/config.json`.
- [gates](https://github.com/fleetorders/etymd/blob/main/docs/gates.md): CI, the generated hooks, your own checks beside them, the content screen, the commit subject check.
- [the fleet manifest](https://github.com/fleetorders/etymd/blob/main/docs/fleet.md): `registry.json`, the sweep, milestones and the board, `etymd propose`.
- [known limitations](https://github.com/fleetorders/etymd/blob/main/docs/limitations.md): the accepted trade-offs.
- [design record](https://github.com/fleetorders/etymd/blob/main/docs/decisions.md): what was decided and why.

## Programmatic use

```ts
import { runAudit } from "etymd"

const audit = await runAudit(process.cwd(), { persistLedger: false })
console.log(audit.findings) // one schema: claim · evidence · why · action · effort · confidence
```

## How this is validated

Every heuristic here exists because a real repository proved the previous one wrong, and each skip
class in the truth lens is a false positive found that way. The fixtures in `test/` reproduce each
case, so the suite runs the same checks on a fresh clone. The repo also runs `etymd audit` on
itself in CI, so its own instruction files are held to the same standard.

## Roadmap

One objective governs everything here: keep your agent instructions true. An item that does not
serve it does not ship. The `--json` schemas are stable, with one declared exception: the fleet
`--json` output, the `proposal/1` record and the `registry.json` schema may still change before 1.0.

Next:

- **Config file, remaining surface**: path-heuristic ignore rules and per-finding suppressions as
  an alternative to ledger dismissal.
- **CI recipe hardening**: document the two-job pattern (audit `--fail-on risk` on pull requests;
  a scheduled full audit that comments the ledger diff).
- **Context-economy deepening**: measure the delta an extraction actually buys (before and after
  words per session), so the lens's advice carries a number.

Later, only if the objective still leads:

- **Fleet follow-ups, each waiting for its evidence**: manifest-side contract audits (a contract
  kept beside the manifest, verified against the repository it describes); `fleet serve` as a
  read-only MCP access layer; `fleet init` scaffolding, not before three measured hand-scaffold
  events; a `--usage` sweep flag, only if a sweep habit shows what is worth counting.
- A registry `contract.state` override (`STATUS.md`, say) is freshness-checked but does not yet
  join the context measurement; join it by artifact kind.
- More instruction dialects as they standardize (new agent config locations).
- Editor surfacing (a problems panel fed by `--json`). LSP and autofix stay out of scope.

## License

MIT
