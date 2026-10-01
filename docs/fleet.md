# The fleet manifest

`etymd fleet` extends the one objective across every repository you work in: your fleet of
**repositories**, not a fleet of agents. The manifest, `registry.json`, is itself an
agent-context file: claims about your repositories (what exists, where, under which
**profile**: `personal`, or `guarded` for an entry whose real path never appears in a tracked
file and into which the tool never writes). It rots like any AGENTS.md does, and `etymd fleet`
keeps it true. The design is D-004 in the
[design record](https://github.com/fleetorders/etymd/blob/main/docs/decisions.md). Both the
registry schema and the fleet `--json` schema may still change before 1.0.

Two files beside each other; the split is the privacy model.

`registry.json` (tracked; safe to publish by construction):

```jsonc
{
  "registryVersion": 1,
  "root": "~/projects", // ~ expands on the consumer side, never a machine home
  "orientation": { "root": "notes" }, // optional: the entry every other entry is guided by
  "projects": [
    {
      "name": "web-app",
      "kind": "repo",
      "profile": "personal",
      "path": "web-app",
      "trust": "private",
    },
    {
      "name": "notes",
      "kind": "docs",
      "profile": "personal",
      "path": "notes",
      "trust": "private", // mandatory on every non-guarded entry, see below
      "staleAfterDays": 45, // per-entry freshness window
      "contract": { "state": "STATUS.md" }, // native conventions register, never migrate
    },
    {
      "name": "my-fork",
      "kind": "tool",
      "profile": "personal",
      "path": "my-fork",
      "upstream": "origin", // freshness measured on fork-authored commits only
      "trust": "public-repo", // private identifiers are screened out (see below)
    },
    // Guarded entries: opaque alias, private, NO path. Real dirs live only in the local file.
    {
      "name": "c-one",
      "kind": "repo",
      "profile": "guarded",
      "private": true,
      "staleAfterDays": 45,
    },
  ],
}
```

`registry.local.json` (gitignored; this machine's facts, each one an identifier you don't ship):

```jsonc
{
  "machineProfile": "guarded", // which profile this machine resolves; "personal" resolves guarded entries disclosed-absent
  "root": "~/projects", // optional per-machine root override
  "dirs": { "c-one": "~/projects/real-guarded-dir" },
  "labels": { "c-one": "real-guarded-dir" },
  "guardedHosts": ["git.example-guarded.com"],
}
```

Two fields the scan can never derive, so the manifest must declare them:

- **`trust`, mandatory on every non-guarded entry** (`public-repo` | `public-bound` | `private`).
  It is a _safety predicate_, not a label: it decides whether content screening applies, so an
  absent value is reported (`fleet check` flags it), never read as a silent `private`.
  `public-bound` means private today, plausibly public later, screened exactly as hard as
  public, because publishing exposes _all_ history: the scrub has to precede the first commit,
  not the visibility flip. A value outside the vocabulary is flagged rather than coerced, so a
  typo can never quietly disable screening. Guarded entries omit it; `profile: "guarded"` already
  implies the answer.
- **`orientation.root`, optional, declared once.** Names the one entry every other entry is
  guided by. Declared at the manifest level rather than repeated per entry, because a per-entry
  link carries no information and can be forgotten: hoisting it makes an unoriented project
  unrepresentable instead of merely detectable. Manifests without an orientation root omit the
  block; etymd never assumes one.

`etymd fleet add <dir>` is the gate that keeps both true: it scans the project, prompts for what
no scan can derive, and **refuses to write an incomplete entry**. Non-interactive runs (`--yes`,
CI) must pass every mandatory value as a flag; there is deliberately no default. It also refuses
a repo whose `CLAUDE.md` hides its `AGENTS.md`: Claude Code reads `CLAUDE.md` when one exists and
falls back to `AGENTS.md` (from 2.1.277) only when none does, so a `CLAUDE.md` must import
`@AGENTS.md` or be a symlink to it; the refusal prints the fix. A repo with `AGENTS.md` alone
registers; on a Claude Code older than 2.1.277 it gets a note, since that version cannot see it.

## How the sweep behaves

- **Read-only by default, everywhere.** The sweep never creates `.etymd` anywhere.
  `--persist-ledgers` persists only into personal repos that already opted in, and a **guarded
  worktree is never written**, regardless of flags, even if a stray `.etymd` exists inside it
  (pinned by test). Guarded findings stay dismissible: their ledger lives at
  `<manifest-dir>/guarded/<name>/.etymd/`, beside the manifest.
- **Deltas.** Each sweep compares against `last.fleet.json` stored beside the manifest and
  renders `Δ +new −resolved` per project. Add `*.fleet.json` to the manifest repo's
  `.gitignore`; sweep output is local-only and never tracked.
- **Recurring classes.** A finding class open in two or more projects renders as its own section
  of class-fix candidates (worst tier first): the sweep asking "repo bug or shared bug?", a
  lesson no per-repo audit can see. The sweep only groups; the class vocabulary is minted by the
  engine's lenses.
- **Declared absence is honored.** An entry whose contract declares `"placement": "none"` states
  that instruction files are legitimately absent in that project; the sweep drops its
  missing-contract finding instead of re-reporting a decision every run.
- **The checks on the manifest's own entries.** Guarded contract files found inside a guarded
  worktree, unregistered checkouts under the fleet root whose remotes match `guardedHosts`,
  tracked `/Users/` paths in the manifest repo, private identifiers from the local file (labels,
  dir names, hosts) inside `trust: "public-repo"` entries, guarded-host commit emails on personal
  entries, and repos whose `AGENTS.md` no `CLAUDE.md` pointer or symlink makes visible to Claude
  Code (`claude-pointer-missing`): each a risk finding; each check that cannot run is disclosed.
  These are not ledger-quietable; the only honest resolution is fixing them.
- **No global pointer.** `--manifest` is required unless the cwd holds `registry.json`. There
  is deliberately no env var and no home-directory pointer.
- **Milestones and the fleet board.** A project declares its plan in one file, `MILESTONES.md`,
  registered as `"contract": { "milestones": "MILESTONES.md" }` (`fleet add` registers it when
  the file is present; `"none"` declares a project deliberately carries no plan). The file has a
  fixed shape so the sweep can read every plan without an agent: a `# Milestones` heading, then
  a table `| id | milestone | goal | status | next | effort | depends-on |` where `id` is `M<n>`,
  `goal` is 1, 2 or 3 (your own ordered goals, declared outside this tool), `status` is planned |
  active | blocked | done, `next` is the one concrete next step, `effort` the S | M | L remaining,
  `depends-on` a list of ids or `—`. Prose after the table is free. The sweep files a gap when a
  declared file is absent or off-shape. `etymd fleet board --initiatives <file> --out <file>`
  renders every project's rows, a ranked initiatives table (`| rank | id | initiative | goal |
status | next | effort | projects | depends-on |`, the one hand-edited manifest-level table), and
  totals; guarded entries never appear on it. Day-precision stamp, deterministic output, exit
  code 1 when any project is missing or invalid: a board with holes still renders, and says so.

Formatter interop for the `.etymd` state the sweep resolves: same rule as everywhere, see
[configuration](https://github.com/fleetorders/etymd/blob/main/docs/configuration.md).

## Rubric-scored proposals (`etymd propose`)

The sweep already gives every improvement finding an action, an effort and a confidence, and
names the classes open in two or more projects. `etymd propose` adds the scoring step, against a
rubric **you author**, because what is worth doing is your call, not the tool's:

```
severity: 2      # risk=3 · gap=2 · polish=1
economy: 3       # S=3 · M=2 · L=1
confidence: 1    # high=3 · medium=2 · low=1
breadth: 4       # projects carrying it, capped at 3
```

One criterion per line (`#` comments and blanks ignored). Those four criteria are the whole
vocabulary; each is computed from finding facts, so a score is arithmetic, not an opinion, and a
line naming anything else is refused quoting the line. `score` is the sum of weight × value; a
line **fires** (listed in `matched`) when the subject reads at or above the criterion's midpoint.

```bash
etymd propose --manifest registry.json --rubric opportunity.rubric --json
# or, without re-sweeping: --from <fleet.json> (a stored `etymd fleet --json` output)
```

Subjects are every `kind: improvement` finding from personal projects plus every recurring
class, recomputed over personal projects only; **guarded entries are excluded from the output
entire, by name**. A class is scored conservatively (worst tier, dearest effort, weakest
confidence). Each `proposal/1` record carries id, class, projects, action, effort, confidence,
score, the fired rubric lines, and an `implications` block (projects, files, gates,
reversibility) extracted from the findings' evidence; files are path-shaped evidence tokens,
and `undetermined` reversibility says so rather than guessing. Read-only and deterministic: no
timestamps, nothing written, identical input gives identical bytes, so a filed proposal can be
re-derived and compared. The design is D-012 in the
[design record](https://github.com/fleetorders/etymd/blob/main/docs/decisions.md).
