# etymd

## 0.20.0

### Minor Changes

- 3e72375: The content screen no longer reads the older `.artifact-check-allow` file name. When only that file exists, the screen prints a hint to rename it to `.etymd-screen-allow`; until then its records exempt nothing.

### Patch Changes

- 2ad9453: `docs/decisions.md` is recognised as a decision record, so `D-NNN` citations resolve against it. A decisions-format marker counts only on a line of its own; one mentioned in prose or inline code no longer opts a file into format checks.
- 68b13b6: Repository shape: the design record lives in `docs/decisions.md`, the README is split into reference pages under `docs/`, one CI workflow, plain comments and messages, a condensed changelog. The generated shell-discovery script's header comment changed, so `etymd gates` reports it stale once and regenerates it.

## 0.19.5

### Patch Changes

- 43ca987: The generated pre-push hook and the premise disclosures use neutral wording: the
  namespace-prefix examples read `app:` and `lib:`, and the hook comment no longer describes one
  machine's setup.
- 9473bfd: `etymd gates --ci` is removed. The option only printed a note that an AI-review CI job
  would ship in a later release; it never ran a check, and nothing else changes with it.

## 0.19.4

### Patch Changes

- 5ceccec: Generated pre-push hooks honour a repo's `.shellcheckrc` again; since 0.19.3 its
  settings were silently ignored, because only scripts were read into the check's scratch tree.
  Every `.shellcheckrc` in the pushed commit is now read in as a raw blob, and when one turns
  `external-sources` on, the files the scripts source (a `.` or `source` argument, or a `source=`
  directive, followed through nested helpers) are read in too; nothing is checked out, so an
  unrelated file's checkout filter can never refuse the push. Regenerate existing hooks with
  `etymd gates --yes`.

## 0.19.3

### Patch Changes

- bcd629d: Generated pre-push hooks read each pushed commit's scripts as raw blobs from git
  instead of checking the commit out; a checkout applied `.gitattributes` line-ending conversion,
  so under `eol=crlf` a script's shebang line ended in a carriage return and the script silently
  left the checked set. One `git grep` pass now finds the changed files with a `#!` line, which
  makes a whole-tree check faster than before; symlink entries are a disclosed skip, since a
  link's target is checked under its own path. The classifier refuses the old call shape, so a
  hand-edited pre-push kept across a regeneration stops the push and says to run `etymd gates`;
  regenerate existing hooks with `etymd gates --yes`.

## 0.19.2

### Patch Changes

- b46bbb9: Generated pre-push hooks check only the shell scripts each pushed commit changes,
  instead of every script in every pushed commit's tree; a commit that changes the gate itself,
  its classifier or a `.shellcheckrc` (deletions included) is still checked whole, as is the
  commit that installs the gate, and a commit with no shell script says so. Pointer checks no
  longer accept an `@AGENTS.md` import inside a fenced code block, an unreadable Claude Code
  version counts as too old instead of passing, and `init` warns when a `CLAUDE.md` or
  `.claude/CLAUDE.md` hides `AGENTS.md`. Regenerate existing hooks with `etymd gates --yes` to
  apply the change.

## 0.19.1

### Patch Changes

- 51ecbc9: Generated pre-push hooks shellcheck every commit in the pushed range, each materialised
  from git's object store instead of read from the working tree. A push whose tip is clean but
  whose earlier commits carry a broken script is now refused; a push that creates a branch checks
  every commit no remote already has; and a commit that cannot be materialised refuses the push
  rather than passing as unread. Regenerate existing hooks with `etymd gates --yes` to apply the
  correction.

## 0.19.0

### Minor Changes

- 29c7b31: The Claude Code pointer check follows Claude Code 2.1.277, which reads `AGENTS.md` when
  a directory has no `CLAUDE.md`: a repo with `AGENTS.md` alone now passes and `fleet add`
  registers it, and the finding (`claude-pointer-missing`, tier gap) appears only when the
  installed Claude Code is older than 2.1.277, where `fleet add` prints a note instead of
  refusing. A `CLAUDE.md` that exists without importing `@AGENTS.md` stays a risk and a refusal,
  because Claude Code reads that file instead on every version. The version is read from
  `claude --version`; `ETYMD_CLAUDE_VERSION` pins it, and `none` means no Claude Code on the
  machine.

### Patch Changes

- 3dd2683: Dependency advisories cleared inside the declared ranges: `vitest` 4.1.10 → 4.1.11
  closes GHSA-82fw-gwwq-j7x9, and `js-yaml` 4.1.1 → 4.3.2 with its transitive 3.15.1 → 3.15.2
  closes GHSA-2883-xcg3-v3hh; both are dev-only, so the published build is byte-identical. One
  advisory stays open deliberately: GHSA-g7r4-m6w7-qqqr (low: `esbuild` allows an arbitrary file
  read when its development server runs on Windows) is fixed in esbuild 0.28.1, while `tsup` 8.5.1
  declares `esbuild: ^0.27.0`, so no in-range version carries the fix; it clears once tsup widens
  its range.

- 7d4e81f: `core.hooksPath` is read the way git reads it: a repo-relative path, an absolute path
  and a `~` path can all name one directory, and the directory is the fact. An absolute path to
  the tracked `.githooks/` now scans as `githooks` (wired) instead of `custom`, and the hooks are
  read from the directory git actually runs; the old literal comparison could also join an
  absolute path onto the repo root and report a working pre-push gate as absent. The fact is
  recorded repo-relative whenever the directory sits inside the worktree, so a committed baseline
  never carries a machine path; a hooks directory outside the repo stays absolute and is disclosed
  as `custom`.

## 0.18.0

### Minor Changes

- 41b91f6: Generated pre-push hooks preserve long filenames, whitespace, quotes and leading
  hyphens during shell-script discovery and checking, and a name carrying shell metacharacters
  reaches the scan as data, never as code. Discovery fails closed instead of reporting success
  with incomplete coverage: failed enumeration blocks, and a tracked regular file that exists but
  cannot be read blocks, naming the file; tracked paths with nothing readable behind them
  (submodule entries, dangling symlinks, files deleted from the worktree while still tracked) are
  counted and disclosed as skipped, so a submodule can no longer wedge every push. Shebang reads
  are bounded to the first 4 KiB of the first line, so a large binary cannot be copied into the
  scratch file on every push; regenerate existing hooks with `etymd gates --yes` to apply the
  correction.
- 4a92435: The shebang classifier ships as a tracked, shebanged helper beside the hook
  (`.githooks/discover-shell-scripts.sh`), so the scan it implements finds and checks it too: the
  gate covers its own classifier.

## 0.17.0

### Minor Changes

- The content screen's allow file accepts a `generated <path-regex>` record: a path declared as
  regenerated data is still read and still screened, but vocabulary-class patterns drop for it,
  while secret-class patterns and the machine-path check stay. The exempted paths are named in the
  output, so a clean run never reads as fully screened. Provenance (reason, date, author) is
  required.

### Patch Changes

- 2bceef1: The `etymd fleet` gate-drift check now derives the pre-push audit tier the same way
  `etymd gates` does. In a repo where no risk-tier rule can fire (no package manifest, no state
  doc) the generator lowers the audit line to `--fail-on gap`, but the drift comparison planned
  with the raw config tier (`risk`), so every repo of that shape carried a permanent `gate-stale`
  finding that the action it named could not clear. The derivation now lives in `planWorkflow`
  itself, where the hook is built, so the drift check, `etymd init` and the programmatic surface
  generate identical bytes; a tier the repo pinned in config is still never lowered.
- 7221fea: The content screen's machine-path rule now fires only at a path boundary (line start,
  whitespace, a quote, `=`, `(`, `[` or `:`), so a home path inside a longer token or a URL, such
  as a test fixture's temp root or a docs URL with a home segment, no longer prints the same
  advisory line on every push. A bare `/Users/<name>/…` or `/home/<name>/…` still hits.

## 0.16.0

### Minor Changes

- dc77a1f: `contract.milestones` and `etymd fleet board`: a project declares its plan in
  `MILESTONES.md` (`# Milestones`, then the header row
  `| id | milestone | goal | status | next | effort | depends-on |`), and the sweep files a gap
  when a declared file is absent or off-shape; `fleet add` registers the file when present.
  `fleet board --initiatives <file> --out <file>` renders every project's rows plus a ranked
  initiatives table and totals, deterministic, with `profile: "guarded"` entries excluded and
  exit 1 on holes.
- b3fb81a: The manifest's second profile is now `guarded` (manifests written by 0.15 or earlier
  carry a different value for it), with every derived name following: `guardedHosts` in the local file, `--profile guarded`, the
  `guarded/<name>/` persistence zone beside the manifest, and the checks on the manifest's own
  entries. There is no alias for the old value: a manifest still carrying it fails `fleet check`
  and names the entry. The feature is a second workspace for entries the tool must not write
  into; its entries stay alias-only and machine-pinned.
- 79af085: `etymd propose` scores the sweep's improvement findings and recurring classes against
  a rubric file of `criterion: <weight>` labeled lines (criteria: severity, economy, confidence,
  breadth; an unknown criterion is refused quoting the line) and emits deterministic, read-only
  `proposal/1` records carrying the score, the fired rubric lines, and an implications block
  (projects, files, gates, reversibility) extracted from finding evidence. Entries with
  `profile: "guarded"` are excluded from the output entirely. Options: `--manifest` (fresh
  read-only sweep) or `--from <fleet.json>` (stored sweep), plus `--json`.

## 0.15.0

### Minor Changes

- 6f40a7d: `etymd premise "<task>"` treats the task you hand an agent as an instruction too.
  Every path, script, well-known doc and decision id the task names is verified against the repo,
  and a missing thing the task is about ranks as risk; a brief hands the agent the premises only
  it can verify. Flags: `--file <path>` (`-` reads stdin), `--json` (schema `premise/1`),
  `--no-brief`, `--fail-on <tier>`; zero trace in a repo that never opted in, and no ledger.
  Prose is read with stricter rules than a code span (a script needs the `run` form, a directory
  claim needs a first segment that exists, a host name is a URL), and every class left as prose
  is disclosed.

## 0.14.0

The generated hooks move from v8 to v12 (`PACK_VERSION`); run `etymd gates` to regenerate every
generated hook and script. Versions 9, 10 and 11 were claimed by work that was reworked before
release and stay retired, so a version cited in a baseline always means exactly one release.

### Minor Changes

- 3056213: Three fixes to the generated gates and the onboarding flow:

  - zsh shebangs are excluded from the shellcheck scan, since shellcheck cannot parse zsh (SC1071
    is a parser-level error no inline directive silences); the hook prints the exclusion (count +
    reason) at run time instead of going quiet about coverage.
  - `~/` home paths are no longer repo file references, so prose like "global rules in
    `~/.claude/CLAUDE.md` apply on top" no longer demands a repo file that was never meant to
    exist; home-path mentions of well-known docs are skipped and disclosed like absolute tokens,
    and one ordinary mention still makes the doc a live claim.
  - `init` no longer scaffolds `AGENTS.md` unasked: the scaffold is opt-in via `--with-agents`,
    and interactive runs still ask first.

- aab88c5: A content gate that cannot run is now caught, and says why. The hooks resolve their
  checker at run time, from outside the repo, so whether the gate will actually run is the one
  thing reading the hook cannot tell you; when the resolved checker did not understand `screen`,
  the commit hook failed closed on that program's own bare error, while the push hook, advisory
  by design, skipped its whole-tree pass in silence. Two changes:

  - After a failed screen, and only then, the hook asks the checker whether it understands
    `screen` at all; if it does not, it prints a line naming the version floor (`screen` needs
    etymd 0.11+) and the override, instead of leaving the checker's unexplained "unknown command"
    as the last word. A screener reporting a real finding is left to speak for itself.
  - `etymd audit` and `etymd doctor` now check reachability: gate integrity resolves the screen
    runner exactly as the hook would and reports a risk-tier finding when a checker resolves but
    cannot screen. No checker installed stays the designed no-op, disclosed and never a finding.

- 6536081: Generated hooks no longer guess at the content screener by path. The old resolution
  included a bare `[ -x ./dist/cli.js ]` check ahead of the `etymd` on PATH, so any repo that
  builds its own binary there had the hook invoke that binary as the screener: it does not know
  `screen`, so the commit hook failed closed on every commit while the push hook skipped its
  whole-tree pass in silence. Resolution is now `CONTENT_GATE`, then the `etymd` on PATH; the
  dev-build arm remains for the repo that develops the screener itself, decided at generation
  time from the manifest name and emitted nowhere else; regenerate with `etymd gates`, and a repo
  needing a different runner for one invocation still has `CONTENT_GATE`.

- 0c0bcc6: Generated pre-push steps run scrubbed of git's exported `GIT_*` environment. Git
  exports `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and more to every hook it runs, and a
  child `git` that inherits them ignores its cwd, so a test suite that builds fixture
  repositories by shelling out to `git` could operate on the real repository while the same suite
  outside a hook was harmless. Every gate step now runs through a `run_gate()` helper that strips
  each exported `GIT_*` name found in the environment, not a fixed list; the audit and shellcheck
  steps stay unscrubbed, and the `.local` companion note documents the wrap so a hand-written
  guard can scrub the same way; existing hooks pick this up on the next `etymd gates` run.

### Patch Changes

- 1cae71b: Context economy counts a file once when two instruction names are the same file.
  `AGENTS.md` symlinked to `CLAUDE.md` used to be measured under both names, doubling the
  reported always-loaded footprint and firing the heavy-file finding twice for one file.
  Candidates resolving to the same inode (symlink or hardlink) are now counted once and reported
  under every name they answer to, in `etymd audit` and `etymd context` alike, with the merge
  stated in the lens disclosures.

## 0.13.0

### Minor Changes

- 9b45d54: The content screen's machine-path check now also skips on upstream-owned files. The
  upstream-ownership exemption already skipped vocabulary-class patterns on files byte-identical
  to public upstream, but the absolute-home-path check still fired on them, so a fork syncing a
  container-based project kept blocking on generic container paths (`/home/<user>/...`) that are
  already public upstream and never name the local machine. The machine-path check is now skipped
  for upstream-owned files exactly like vocabulary-class patterns; secret-class patterns stay
  absolute on every file, and the machine-path check still fires on all other files unchanged.

## 0.12.0

### Minor Changes

- 060c50b: Forks can exempt upstream-owned files from vocabulary-class patterns, so a sync that
  stages hundreds of upstream files is not blocked by patterns matching ordinary wording in
  upstream's own already-public docs.

  - **Pattern classes.** A `# class: vocabulary` directive in the pattern file marks the patterns
    beneath it as vocabulary; everything else stays `secret`. Files with no directive are
    unchanged: every pattern absolute.
  - **Upstream ownership by blob identity.** With `--upstream <remote>` or
    `git config etymd.upstream <remote>`, a staged or tree file whose content matches any blob at
    the tips of `refs/remotes/<remote>/*` is upstream-owned, and its vocabulary-class patterns
    are skipped; secret-class patterns and the machine-path check stay absolute everywhere.
    Matching is by blob sha across all upstream refs, so a file copied verbatim to a different
    path is still recognised, and a file the fork modifies is screened in full.
  - **Fails closed and loud.** If the upstream ref cannot be read (a rebuild dropped the remote),
    nothing is exempted and a one-line notice says so; the config signal persists, so the fork
    still knows it is a fork.

## 0.11.0

### Minor Changes

- 1193d71: Content screen: allow-file entries carry provenance, and the environment bypasses are
  gone.

  - Repo-level exceptions now live in `.etymd-screen-allow` (the previous `.artifact-check-allow`
    is still honoured) as records of labeled lines: `pattern`, `reason`, `date`, `author`. The
    pattern is the rest of its line, verbatim, and may contain any character, `|` included.
  - An entry naming the repo itself needs no provenance (a bare `^widget$` line is a complete
    record); anything else missing a field is reported and does not apply.
  - The environment bypasses `CONTENT_GATE_PREPUSH` and `ARTIFACT_CHECK_SKIP` are removed; the
    allow file is the one bypass path left, and every entry in it says who exempted what, when,
    and why.
  - Generated hooks now resolve their screener in a defined order: an explicit `CONTENT_GATE`,
    then the repo's own `./dist/cli.js` when it builds one, then the `etymd` on PATH. Run
    `etymd gates` to pick up the v8 generated hooks.

### Patch Changes

- 652a353: Dependency advisories, 2026-08 batch: vitest 2.1.8 → 4.1.10, @changesets/cli
  2.27.11 → 2.31.1, tsup 8.3.5 → 8.5.1, plus in-range transitive fixes (js-yaml, nanoid,
  postcss, tmp); all 260 tests pass on vitest 4 unchanged. One low stays open: esbuild
  0.27.3–0.28.0 allows an arbitrary file read when its development server runs on Windows,
  reached only through tsup (which pins `^0.27.0`); it clears once a tsup release carries esbuild
  0.28.
- 9521732: A clean `etymd screen` run now reports itself, with the file count. A clean run used
  to print nothing, so from inside a hook, where the exit code is the only other signal,
  "silent" and "never looked" were indistinguishable. Every run now prints its summary line
  (scope, files scanned, binary skipped) and a clean run says so; hooks gain one line per
  successful commit, and a silent screen remains possible only where the screener is absent,
  which the tool already reports as inert rather than clean.

## 0.10.0

### Minor Changes

- 2efbd34: `etymd gates` can now check the commit subject against Conventional Commits, at the
  commit-msg hook the content screen already used; run `etymd gates` to pick up the v7 generated
  hooks. The check is off unless you ask for it: set `gates.commitFormat: true` in
  `.etymd/config.json`; anything else, including leaving the key out, writes exactly the hook you
  got before, since this is the one generated check that needs nothing installed and would
  therefore run for everyone who clones your repo. Where it is on, it is a format check, not a
  taste check: an over-long subject is advice and never blocks, and the subjects git writes for
  you (merge, revert, fixup, squash, amend) are exempt.

### Patch Changes

- 5104394: The content screen recognises a repo's own name however the pattern spells it. The
  self-name exemption compared a pattern's raw source to the repo's directory name, so
  word-anchored patterns like `\bwidget\b` never matched and the exemption silently stopped
  applying: the repo began reporting its own `package.json`, its own contract titles and its own
  storage keys as leaks. A pattern is now exempt when the single string it matches is one of the
  names the repo can prove is its own (the union of the directory, the `name` in `package.json`
  with the npm scope stripped, and the basename of the `origin` remote), with word anchors
  accepted; any pattern that can match more than one string (a class, a quantifier, an
  alternation) is never exempt, and where no name can be read, every pattern stays active.

## 0.9.1

### Patch Changes

- 91ddb97: The content screen skips binary files, and says how many were skipped. Short patterns
  match inside compressed bytes by accident and surface as a "line" of mojibake, so every pattern
  added to a file raised the false-positive rate across every repo that holds assets. Files whose
  first 8KB contain a NUL byte are now skipped rather than screened, and the count is reported in
  the summary header (`· N binary skipped`), so "no findings" can never quietly mean "the bytes
  were never looked at".

## 0.9.0

### Minor Changes

- 35dbeab: State documents are checked for truth, not only for age: the instruction-truth lens
  runs its command-claim and path-claim checks over detected state docs and resolves their
  `D-NNN` decision references against the repo's decisions file, so a citation of an entry that
  was never written is a gap finding. References naming another record ("peer D-050") and
  citations against directory decision conventions are skipped and disclosed, never accused.
  Script claims are also now checkable in repos with no package manifest at all, where nothing
  could ever satisfy them.

## 0.8.0

### Minor Changes

- bad1380: `etymd gates` no longer writes a gate that cannot fail. It derives whether any
  risk-tier finding is reachable in the repo (a package manifest to contradict, a state document
  to fall behind); where none is, the generated hook drops to `--fail-on gap`, and the output
  says so and why. A `failOn` recorded in `.etymd/config.json` is never adjusted, and `gates` now
  states which tier it wrote and where that tier came from; the config key was previously
  unmentioned anywhere in its output.
- e873664: Declared-field checks are forward-only from the marker's position, not from the file.
  A decisions file that declares required entry fields mid-life no longer demands them from
  entries appended above the marker; the built-in `Scope:` check shares the same gate, while
  `Revisit:` keeps whole-file reach, since it fires only where the entry already wrote a date
  down. Entries exempt by position are counted and named in the lens disclosures.

## 0.7.0

### Minor Changes

- d27d635: Decisions records can require fields of their own. A decisions file that already opts
  into per-entry format checks with a marker can append field names to it,
  `<!-- decisions-format: 1 fields=Owner,Rollback -->`, and every entry after the marker must
  carry each one; `Owner:` and `**Owner:**` both count. Declarable names are letters, digits,
  spaces, `-` and `_`; a name that cannot be used as a field, a marker version this build does
  not know, and a redeclared `Scope` are each disclosed in the lens report. A marker without
  `fields=` behaves exactly as before, pre-marker entries stay untouched, and the declaration
  lives on the marker so a repo can keep two decision records with different obligations.

## 0.6.0

### Minor Changes

- 47c5032: Local gates: the tool now reads and rewrites what it generated, instead of guessing
  about it.

  - `gate-integrity` follows the `<hook>.local` include: each generated hook opens by sourcing a
    sibling companion (`.githooks/<hook>.local`), a file etymd never reads, writes or
    regenerates, so a check placed there previously ran on every push while being reported as
    enforced only in CI. The lens now resolves the companion for `pre-commit`, `pre-push` and
    `commit-msg`, counts what it enforces, and reports a present-but-not-executable companion as
    inert, named, with the `chmod +x` that would make it run.
  - A stale generated hook is no longer indistinguishable from a hand-edited one. Generated shell
    files carry a stamp as their last line whose digest covers the file minus that line: a file
    that still hashes to its own stamp is byte-for-byte what etymd wrote and is regenerated
    freely, while any edit breaks the match and the file is kept. The plan tags a stale file
    `[stale]` and says it is regenerating, and says why it is keeping the others; a hook
    generated before the stamp existed is kept, now with the reason and the way out stated, and
    one regeneration makes it provable from then on.
  - Provenance applies to everything etymd generates, not just hooks. The `AGENTS.md` scaffold is
    stamped too, in an HTML comment; its stamp replaces the bare `<!-- etymd pack vN -->` line,
    carrying the same version plus the provenance. `.etymd/config.json` stays excluded, since it
    holds the user's recorded decisions and is merged into rather than generated.
  - New finding `gate-integrity/companion-not-executable` (tier `gap`): a `<hook>.local` that a
    hook calls, that exists, and that provably lacks the execute bit, so the check inside is
    skipped silently on every run. The action names both halves of the fix, since `chmod +x`
    alone does not survive a fresh clone; "not executable" is trusted only where the hook beside
    it has the bit, and where that cannot be established the checks are counted and the
    uncertainty is disclosed.
  - The `etymd fleet` sweep no longer reports a provably hand-edited gate as drift under one
    finding whose action, "re-run `etymd gates`", does not work for a hand-edited hook; it
    discloses it as a customisation, while stale and unstamped gates stay in the finding, since
    being unable to prove a file was touched is not evidence that it was.
  - `PACK_VERSION` moves to 6: the generated files change meaning.

### Patch Changes

- `yaml` moves from 2.7.0 to 2.9.0, clearing GHSA-48c2-rrv3-qjmp (stack overflow on deeply
  nested collections) from the dependency tree of everyone who installs etymd. The lens that
  parses CI files already wrapped every `YAML.parse` so that a hostile deeply nested
  `.gitlab-ci.yml` was caught and disclosed as a parse error rather than crashing, so the bump is
  about not shipping a known-vulnerable dependency.

## 0.5.0

### Minor Changes

- e265713: `fleet add --profile guarded` now records the alias-to-directory mapping too, not just
  the entry. An entry with `profile: "guarded"` in the tracked manifest is deliberately
  alias-only (no path, no remote), so it resolves to nothing on its own, and registering only
  that half left a dangling entry that `fleet check` reported immediately. The mapping is written
  `~`-relative (so the local manifest stays portable between machines), merged into the existing
  document (so hand-maintained entries survive), and written before the tracked entry;
  registration refuses if the local manifest is not gitignored, and refuses rather than overwrite
  mappings when the file exists but is not valid JSON.
- e8ed2ba: `fleet add` no longer records a remote URL in the manifest. Nothing in the tool ever
  read the field back, and a raw remote URL carries the host and the internal group path where
  `path` carries a bare directory name, so removing the field retires that disclosure class
  outright. Existing entries that already carry a remote are left alone.

## 0.4.2

### Patch Changes

- 88492b5: Fix: `fleet add --profile guarded` was silently ignored, registering such repos as
  personal; the personal branch records `path` and the raw `remote`, writing the host and its
  internal group structure into a manifest that is tracked and pushed. The CLI now reads the
  merged option view, so the flag works in any position. `fleet add` also refuses outright when
  the target's remote matches a host declared in `guardedHosts` while the profile is not
  `guarded`: the manifest already knows which hosts belong to entries the tool must not write
  into, so the tool has every fact needed to prevent the mistake without anyone remembering a
  flag.

## 0.4.1

### Patch Changes

- 821f144: Fix: the shell gate now actually prints the sub-warning findings it documented. The
  generated hook previously ran only `shellcheck -S warning` and discarded everything below that
  bar. It now runs a second, non-blocking pass after the blocking one; the result is captured
  into a variable and explicitly tolerated with `|| true`, so it has no path to the exit code,
  and the blocking bar is unchanged; generated hooks v5.

## 0.4.0

### Minor Changes

- 59c506d: Gate the shell surface: `etymd gates` now installs a shellcheck step in repos that
  have one. The scan counts tracked files a shell executes (`facts.shell.scripts`), by extension
  and by shebang, and the generated pre-push gains a shellcheck step when that count is non-zero;
  the install summary lists the step too. Scripts are re-discovered inside the hook at push time,
  by shebang over tracked files, never baked in as a list; a missing shellcheck binary is a loud
  skip that names the install command, never a quiet pass; and the blocking bar is severity
  `warning`, with style and info printed as advice; generated hooks v4.

## 0.3.2

### Patch Changes

- A truth finding from any lens now reaches a `doctor` run: `doctor` filters to truth-only, and
  it used to filter at the lens level, so `gate-integrity` was skipped entirely and its
  `hooks-not-wired` finding (tier: risk, "tracked hooks exist but never run") was invisible in
  the one view meant to catch it. `kind` now lives on the Finding, defaulting to the lens kind
  when a finding does not set its own, and the `--truth` filter operates at the finding level
  after every lens has run, so nothing objective is invisible. Also in this release: CI proves
  the publish tarball's exact manifest on every push (packagers ignore `.gitignore`, so a stray
  local file can ship while every git-scoped check stays green), and the generated hook
  companions (`.githooks/<hook>.local`) ship in this repo as a worked example of the
  resolve-by-name convention.

## 0.3.1

### Patch Changes

- Regeneration keeps what a repo already had, and a manifest can declare that a repo has no
  gates.

  - Preservation moved into the generator: `etymd gates` kept a test step an existing hook
    already ran, but every other caller did not, including the `etymd fleet` gate-drift check,
    which compared each repo against a hook missing checks the repo really runs and reported
    permanent false drift.
  - `gates: "none"` in a fleet manifest declares that generated gates are deliberately absent,
    for a prose repo with nothing mechanically checkable or one that gates itself by hand; the
    absence is disclosed rather than hidden, and an undeclared absence still reports.
  - A hand-written `.etymd/config.json` no longer crashes the generator: setting only
    `gates.failOn` used to throw.
  - The publish gate points at the committed script: `prepublishOnly` resolving a bare
    `artifact-check` from `PATH` meant the hook guarding what actually ships was silently absent
    for every clone but one.

## 0.3.0

### Minor Changes

- Content screening, a registration gate, and gates that can be regenerated without loss.

  - **`etymd screen`** offers four scopes for the four ways content leaves a repository:
    `--staged` (a commit), `--message` (the message, which the staged scan cannot see), `--tree`
    (everything tracked), and `--dir` (an unpacked build artifact; `npm` and `vsce` ignore
    `.gitignore`, so a local file can ship to users while every git-scoped check passes). It
    ships no patterns: you supply a pattern file, and without one the command is inert and says
    so, rather than reporting clean for a check it did not run. A repository naming itself is
    exempt, and a repo-level allow file covers lines that cannot carry an inline marker.
  - **`etymd gates`** generates all four hooks, including a `commit-msg` hook and a publish-time
    screen wired to the key the project's publish route actually runs (`vsce` ignores
    `prepublishOnly`). Generated hooks resolve the screener at run time and no-op when it is
    absent, so the same file is safe to commit to a public repository.
  - **Your own checks live beside the generated ones.** Each hook calls `.githooks/<hook>.local`
    if it exists, a file etymd never reads, writes, or regenerates; regeneration no longer forces
    a choice between accepting the generated hooks and keeping your own guards, and it will not
    drop a test step an existing hook already ran.
  - **Setup is one keystroke.** `gates` shows a plan with every derivation stated and asks once;
    `customize` reaches each choice. Answers record to `.etymd/config.json`, where
    `gates._why.<field>` can carry the reason a value is what it is, dropped automatically when
    the value it explains changes.
  - **`etymd fleet add`** registers a project, prompting for what no scan can derive and
    refusing to write an incomplete entry. Manifests listing several repositories gain a
    mandatory `trust` level on entries other than `profile: "guarded"` (absence is a finding,
    never a silent default), a manifest-level `orientation.root` replacing per-entry links, and a
    gate-drift check that reports a repository missing a gate its siblings install.

## 0.2.2

### Patch Changes

- 7bc6cf5: Gate integrity: scripts are detected regardless of how the package manager is
  invoked. Script expansion used to guess the script name positionally, which only held for
  `npm run x`, `yarn x` and `pnpm x`; shapes like `pnpm run typecheck`, `pnpm -s typecheck` or
  `pnpm --filter @scope/pkg test` expanded to nothing, so a pre-push hook running
  `pnpm run typecheck` reported as having no typecheck at all. Expansion now scans the
  invocation's tokens for a name that is a known script: package-manager built-ins are excluded,
  so `npm ci` is never read as running a `ci` script; `test` and `start` stay recognised as the
  shortcuts they are; `exec`/`dlx` end the scan, since what follows is a binary; and `npx` is
  only scanned for `run-s`/`run-p`/`npm-run-all`.

## 0.2.1

### Patch Changes

- 983c0e5: `etymd fleet` sweep: recurring classes, and `placement: "none"` honored.

  - The sweep report groups open findings by their class prefix and lists every class present in
    two or more projects, worst tier first; `--json` gains a `recurringClasses` array (schema
    still EXPERIMENTAL through 0.2.x).
  - A registry entry declaring `placement: "none"`, its contract files legitimately absent, no
    longer gets the absence re-reported every sweep; a standalone `etymd audit` in such a repo
    still reports it, correctly, since no declaration is in scope there. Tier counts summarize
    the filtered list.

## 0.2.0

### Minor Changes

- a336902: Fleet mode: the truth guard across your repositories (the registry and
  `fleet --json` schemas are EXPERIMENTAL through 0.2.x).

  - New `state-freshness` truth lens: state and decisions artifacts are dated by git committer
    dates only, never mtime; staleness is relative, so a dormant repo's old state is current; a
    state character budget measured against the size at which some agent harnesses truncate a
    loaded file; marker-gated decisions format checks (`Scope:`, duplicate or out-of-order
    `D-NNN` ids, past `Revisit:` dates reported as due review debt); ADR conventions
    (`docs/adr/`, `docs/decisions/`, `NNNN-*.md`) recognized natively.
  - New `etymd fleet` command family. The sweep runs a read-only audit per registered repo
    (`--manifest` required unless the cwd holds `registry.json`; no env var, no global pointer)
    and renders one line per project with a delta against `last.fleet.json`, with detail only
    for new or risk findings. `fleet check` validates the manifest pair alone (dangling
    mappings, duplicate names, privacy leaks, machine paths). `fleet dismiss` and `fleet accept`
    resolve a project's finding from any cwd.
  - The manifest loader resolves both the registry pair (`registry.json` plus gitignored
    `registry.local.json`) and the older two-file manifest format (`sources.json` plus
    `sources.local.json`); entries with `profile: "guarded"` are opaque aliases resolved only
    through the local file, and every resolution failure is disclosed, never silently skipped.
  - Persistence invariants: the sweep never creates `.etymd` anywhere; `--persist-ledgers` only
    persists into personal repos that already opted in; worktrees of entries the tool must not
    write into take zero writes under every flag combination, their findings persisting (and
    staying dismissible) at `<manifestDir>/guarded/<name>/.etymd/`; and no content resolved from
    those entries ever lands under the manifest repo's tracked paths.
  - Findings on the manifest's own entries (lens id `fleet-manifest`): contract files of entries
    the tool must not write into found inside their worktree; checkouts under the manifest root
    whose remotes belong to such entries but which are not registered; tracked `/Users/` paths
    in the manifest's own repo; private identifiers inside `trust: "public-repo"` entries; commit
    emails from hosts listed in `guardedHosts` on personal entries.
  - Fork-aware freshness: entries with `upstream` are dated on fork-authored commits only
    (`HEAD --not --remotes=<upstream>`), with a disclosed fallback when the remote is absent.

## 0.1.0

First public release.

The truth guard for agent instruction files: **keep your agent instructions true**. (An earlier
prototype, under the package's former name, was a broader workflow installer.)

- `etymd audit`: verify every instruction claim against the actual repo, through three lenses.
  - **instruction-truth**: command claims vs `package.json` scripts, path claims vs the tree,
    package-manager consistency, cross-reference integrity, and drift vs the committed baseline,
    over AGENTS.md, CLAUDE.md, GEMINI.md, Copilot instructions, Cursor rules, and skills.
  - **gate-integrity**: the CI ↔ local gate inventory (GitLab incl. `!reference`, includes and
    script-less jobs; GitHub; husky modern and v3; lint-staged) with honesty rules: advisory jobs
    are never gates, unseen templates are disclosed, server-side thresholds are named as such.
  - **context-economy**: the always-loaded footprint in words and tokens, plus extraction
    candidates.
  - Ranked findings (risk → gap → polish) with evidence; a committed ledger (resolved, regressed,
    dismissed-never-resurfaces); lens-coverage reporting; `--fail-on <tier>` for CI.
- **Excluding a file never resolves its tracked findings.** A finding missing from a scoped run
  is absent because nobody looked, not because it was fixed: the ledger holds those entries open
  and the diff reports them as held rather than folding them into "N resolved".
- **`init` baselines the repo it leaves behind**: it re-scans after writing its scaffold, so
  deleting the scaffold later registers as drift.
- **The committed baseline carries no machine path**: the scan root is elided on write, and a
  baseline written by an older etymd is detected and disclosed with the fix: `etymd approve`.
- **`.etymd/config.json`** (optional, committed): `instructions.include` and
  `instructions.exclude` globs scope which instruction files are audited, and
  `context.perFileWords` / `context.totalWords` set the economy budgets per repo. Excluded files
  are counted and named in the disclosures, and malformed config is disclosed, so narrowing an
  audit can never quietly buy a clean report.
- `etymd init`: approve the committed baseline, gitignore the cache, scaffold a minimal
  `AGENTS.md` only where none exists; never overwrites.
- `etymd doctor`: alias for `audit --truth`. `etymd context`: the per-file always-loaded
  footprint view. `etymd gates`: local git-hook gates built from the repo's own check commands
  (writers can never enter the gate). `etymd scan`: the deterministic detectors. `etymd brief`:
  the agent briefing for the semantic layer.
- Zero-trace guarantee: read-only probes of foreign repos write nothing.
