# Design decisions

What was decided and why, for anyone changing the code. Code comments cite an entry as
`docs/decisions.md, D-004`. Numbers are stable; a gap is an entry deleted because it no longer
shapes the code.

## D-003 — One objective: keep your agent instructions true

Etymd does one thing: it checks what a repository tells its coding agents against the repository
itself. An instruction is anything told to an agent, in a file (AGENTS.md, CLAUDE.md, rules,
skills) or in the prompt (D-010). The name is Greek _étymon_, a word's true sense, plus the `.md`
family it guards.

Two lenses carry the objective: `instruction-truth` (are the commands, paths and references
real?) and `context-economy` (how much do the always-loaded files cost per session?).
`audit --fail-on <tier>` is the gate. `init` is onboarding only: it approves a baseline and
scaffolds a minimal AGENTS.md when none exists, and never overwrites a file.

**Why:** an instruction file never errors when it goes stale; it keeps instructing, confidently,
and every session inherits the mistake. A tool that measures that one property can be trusted
on it. Earlier designs carried a maturity score, workflow modes, a per-agent adapter layer and a
project-context template; each spent effort on something other than truth, so each was cut.

**Consequences:** anything off the axis does not ship. Out of scope by design: editor
integration and autofix, framework-staleness patterns, dashboards. A feature that is useful but
does not make an instruction truer is declined.

## D-004 — Fleet mode: the same guard across every repository you register

`etymd fleet` sweeps every repository listed in one manifest. Fleet means your repositories, not
a fleet of agents. The manifest is two files: `registry.json` (tracked) names each entry with
its kind, profile and trust; `registry.local.json` (gitignored) holds this machine's facts:
`machineProfile`, `dirs`, `labels`, `guardedHosts`.

A **guarded** entry is one whose real path never appears in a tracked file and into which the
tool never writes. In `registry.json` it carries an opaque alias and no `path`; the directory
lives only in the local file. Its ledger lives at `<manifestDir>/guarded/<name>/.etymd/`, beside
the manifest. The older two-file manifest format (`sources.json` plus `sources.local.json`)
loads through the same resolver.

Rules: the sweep never creates `.etymd` anywhere; a guarded worktree takes zero writes under
every flag; the checks on the manifest's own entries (a real path in a tracked file, an
unregistered checkout under the fleet root whose remote matches a guarded host, a private
identifier inside a `public-repo` entry) are never ledger-quietable. Freshness is read from git
committer dates, never mtime; a fork is dated on fork-authored commits only; a dormant repo is
not stale. A `Revisit:` date that has passed is a finding. ADR directories (`docs/adr/`,
`docs/decisions/`) are recognised as decision records as they are, never migrated.

**Why:** the split between the tracked and the local file is the whole privacy model: the
tracked file is safe to publish by construction, so nothing depends on a reviewer noticing a
path. The write rules exist because a tool that writes into a repository it does not own cannot
be run against repositories you do not own.

**Consequences:** every fleet default, field, finding and doc passes five checks at review:
one-line exit (any convention can be abandoned by deleting a marker or an entry); absence is
legal (a missing artefact is disclosed, never manufactured; `"placement": "none"` is a declared
state); tool-death survival (every file stays useful with etymd uninstalled); name-blind (no
private vocabulary on any shipped surface); opinionated about honesty, never taxonomy (findings
enforce disclosure and truth, never a folder layout or a workflow). Non-goals: no dashboard, no
sync, no transcript reading, no MCP server.

## D-005 — What a user may declare, and the tests an opinion passes before it ships

A finding carries a `kind`: `truth` (an instruction is false) or `improvement` (something could be
better). It lives on the finding, not the lens, because one lens can emit both. The committed
`.etymd/config.json` may carry a `_why` block beside `gates`: a reason attached to a value, keyed
by the field it explains. The tool keeps a reason as long as the value stands and drops it when it
changes the value, because a reason attached to a value it no longer explains is worse than none.

Two tests before any opinion ships in the package: can the tool mechanise the check, and would a
user who is not us ever set this? A check that passes the first and fails the second is how one
team's policy lands in a public package. A new predicate (a check over something the user
declares in config) additionally answers five questions in writing in the pull request that adds
it; a "no" is a rejection:

1. Would a user who is not us ever ask for it? Name their situation without our vocabulary.
2. Is it a question about repository state? Not about a network, a clock or another program.
3. Does it compose, or does it special-case? A shape with parameters, not a policy in disguise.
4. Is it already expressible with what exists plus a parameter, or by a lens?
5. What does its absence cost? If a user writes two rules instead of one, that is fine.

**Why:** a tool that checks truth earns trust only while it holds no opinion of its own about how
a repository should be organised.

**Consequences:** standing non-goals: the tool never executes a user's commands, never defines a
rule language, never loads user code in-process, never judges a `_why` text (it shows the reason;
whether it was good is the reader's call), and ships no preset carrying one team's vocabulary.

## D-006 — Generated hooks: what the tool may read, and what it may rewrite

Every file `etymd gates` generates ends with a stamp line, `# etymd:generated pack-vN <digest>`,
the digest taken over the file minus that line. On the next run the tool compares and reports one
of three states: **stale** (the bytes match the stamp but the templates moved on: regenerate),
**edited** (the bytes no longer match the stamp: keep, and say so), **unstamped** (keep, and say
why). Every generated artefact is stamped; the AGENTS.md scaffold carries its stamp as an HTML
comment. `config.json` is the one exception, because the user edits it by design.

Each generated hook calls a companion, `<hook>.local`, that the tool never reads, writes or
regenerates. The gate-integrity lens follows that call and counts the companion's checks only
when the hook calls it and it passes the hook's `[ -x ]` guard; where mode bits do not exist the
checks are counted and that is disclosed. A companion the hook cannot run (the hook has the
execute bit, the companion lacks it) is a `gap` finding of kind truth whose action names both
`chmod +x` and `git update-index --chmod=+x`. The fleet sweep reports an edited hook as a
customisation, not as drift.

**Why:** a stamp can prove a file is safe to replace; it can never prove a file is unsafe. So the
tool overwrites only what it can prove it wrote and keeps everything else with a reason.

**Consequences:** nothing hand-written belongs in a generated hook; it goes in the companion. A
hook generated before stamps existed is kept until one regeneration makes it provable.

## D-007 — Declared entry fields: the file names them, the tool checks presence only

A decisions file opts into format checks with the marker `<!-- decisions-format: 1 -->` and may
append `fields=Owner,Rollback` to require fields of its own on every entry. The tool checks that
each named field is present (`Owner:` or `**Owner:**` both count) and never interprets a name.
Names may use letters, digits, spaces, `-` and `_`; anything else is disclosed and skipped. The
marker binds entries from its position onward; `Revisit:` dates are checked file-wide. An
unknown format version is read as 1 and disclosed.

**Why:** which fields a decision needs is the team's policy; shipping a vocabulary would be the
tool holding an opinion (D-005). Presence is the one thing it can check mechanically.

**Consequences:** forward-only. Entries before the marker are never flagged retroactively.

## D-008 — The generated gate derives its tier, and says where the tier came from

`etymd gates` derives the audit tier its pre-push hook fails on from what can fire in the repo: a
package manifest means script claims can be checked, so `risk` is reachable; a state document
means staleness can fire. When nothing reachable can produce a risk the hook gates at `gap`, and
the output says so. Uncertain counts as reachable. A `gates.failOn` in `.etymd/config.json` is
never touched; the output always names the tier's source and `gates.failOn` as the durable home
for a different choice.

**Why:** a gate at `risk` in a repo where no risk can fire is a check that always passes, and a
check that cannot fail is an opinion, not a gate.

**Consequences:** the tier in a generated hook can change when the repo changes; the config pin
is how a user stops that.

## D-009 — State documents are checked for truth, not only for age

A state document (`PROJECT_CONTEXT.md`, or the file a fleet entry registers as `contract.state`)
gets the same command and path checks as an instruction file. A `D-NNN` citation must resolve
against a decisions file with `## D-NNN` entries. A dead command is a risk; a dead path or
reference is a gap. A citation of another repository's record ("peer D-050") is skipped and
disclosed; a directory convention (`docs/adr/`, `docs/decisions/`) carries no parseable ids and is
disclosed as unresolvable. A repo with no package manifest anywhere still has checkable script
claims, and they are false.

**Why:** a state document is read as ground truth when a session returns to it; a stale one
misleads faster than a stale AGENTS.md, and a citation the record cannot back sends a reader to a
ruling that was never written.

**Consequences:** the checks live once, in `src/lenses/instruction-truth/checks.ts`, and every
surface calls them (D-010).

## D-010 — The task is an instruction: `etymd premise`

The task an agent is about to be handed is an instruction too. `etymd premise "<task>"` (or
`--file <path>`, `-` for stdin) runs the shared checks on what the task names. Promotion from
prose is stricter than the file extractor: a path needs a directory and a known extension; a
directory needs a trailing slash and an existing first segment; a script needs the `run` form. A
namespace prefix (`app:`, `lib:`) marks another repository's tree: skipped and disclosed. A
missing path is accused only when its first segment starts at a directory of this repo. A dead
path the task is _about_ is a risk, a departure from D-009's gap: the task would solve the wrong
problem precisely.

The brief hands the agent the three premises only it can verify: the named things are the ones
meant; the mechanism the task assumes runs; the state it assumes holds. It is written to
`.etymd/premise-brief.md` only where `.etymd/` already exists. Refused by design: running
anything, calling a model, keeping a ledger, installing a prompt hook.

**Why:** the objective read "instructions" as files, which was right for what it excluded and too
narrow for the one instruction it never considered. A task that names a file which does not
exist sends an agent to solve the wrong problem with full confidence.

**Consequences:** one implementation of the checks for files, state documents and the task.
Tier, wording and the outside-repo path scope are parameters; the rules are not.

## D-011 — Milestones are a contract file; the fleet board is their rollup

`contract.milestones` names a project's plan file (by convention `MILESTONES.md`; `"none"`
declares a deliberate absence). `fleet add` registers it when present and never defaults to
none. The shape is fixed: a `# Milestones` heading, then a table
`id | milestone | goal | status | next | effort | depends-on` where `id` is a unique `M<n>`,
`goal` is 1, 2 or 3 (an ordered rank you define outside the tool), `status` is planned, active,
blocked or done, `next` is non-empty, `effort` is S, M or L, and `depends-on` is ids or `—`.
Prose after the table is not parsed; a header-only table is legal. The sweep files
`milestones-missing` and `milestones-shape:<name>:<n>` gaps. `fleet board` renders an optional
ranked initiatives table, every personal project's rows and totals; guarded entries never
appear; the stamp has day precision; the output is deterministic; the exit code is 1 on holes.

**Why:** a plan the sweep can read without an agent, in a shape that stays useful as a plain
file. Rejected: YAML or frontmatter (a second format to learn), existence-only checks (they say
nothing), a goal vocabulary (the tool's opinion), reading roadmap prose (not mechanisable).

**Consequences:** a project that keeps its plan elsewhere declares `"none"` and is never
nagged; a project that declares a file is held to the shape.

## D-012 — `etymd propose`: findings scored against a rubric file

`etymd propose --manifest <registry.json> | --from <fleet.json> --rubric <file>` is read-only,
deterministic and carries no timestamps. The rubric is labeled lines `criterion: weight`;
comments and blanks are ignored; an unknown, malformed, duplicate or empty line is an error that
names the line, never a default. Four criteria: severity (risk 3, gap 2, polish 1), economy (S 3,
M 2, L 1), confidence (high 3, medium 2, low 1), breadth (projects carrying it, capped at 3).
Score is the sum of weight × value; a line fires at a value of 2 or more. Subjects are
improvement findings plus recurring classes from personal projects only; guarded entries are
excluded by name; truth findings and the manifest's own checks are never scored. Each
`proposal/1` record carries id, class, kind (`finding` or `class`), projects, action, effort,
confidence, score, the fired lines, and an implications block (projects, files, gates,
reversibility: `regenerable`, `git-reversible` or `undetermined`). Ranking is score descending,
then id ascending.

**Why:** what is worth doing is the user's call; the tool computes and does not opine. A lie is
fixed, not ranked, so truth findings stay out.

**Consequences:** rejected on purpose: a default rubric, free-text criteria, a guarded flag, a
cutoff flag. Identical input gives identical bytes, so a filed proposal can be re-derived and
compared later.
