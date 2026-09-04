# 012 — `etymd propose`: improvement findings and recurring classes, scored against a rubric file

Scope: etymd — one new command, one engine module, no change to any lens or to the sweep.

_Status: implemented._

## Why

The sweep already mints everything an improvement proposal needs: every finding carries an
action, an effort and a confidence, and the sweep names the classes open in two or more
projects. All of that dies in a gitignored report — ranked by severity, not by opportunity, and
never in a shape a fleet's planning surface (a queue, a board) can file mechanically. The
missing step is small and belongs here: score what the lenses already said against a rubric the
fleet authors, and emit one stable record per proposal candidate.

This tool does not own the judgement of what is worth doing — the fleet does. So the rubric is
a file, the criteria weights are the fleet's, and the tool's entire contribution is mechanical:
parse the rubric, compute each criterion from finding facts, sum, emit. No default rubric
ships; with no `--rubric` there is nothing to run.

## Decision

1. **`etymd propose --manifest <registry.json> --rubric <file>`** (or `--from <fleet.json>` to
   read a stored sweep instead of running one) scores and prints. Read-only always: it never
   writes `.etymd` anywhere, never moves `last.fleet.json`, and a corp worktree is never
   touched (it calls the engine's sweep directly, not the `fleet` command, so the delta
   baseline is not updated). Output is deterministic — no timestamps — so the same input twice
   yields identical bytes, and a filed proposal can be re-derived and compared.

2. **The rubric file is labeled lines, one criterion per line** (the free-form-field standard:
   label fields, let the line break separate them):

   ```
   # comments and blank lines are ignored
   severity: 3
   economy: 2
   confidence: 1
   breadth: 4
   ```

   A criterion name is a token from the vocabulary below (no whitespace, no `:` — imposed by
   this grammar, which is what makes the single-line label unambiguous); a weight is a positive
   integer. The line is the unit of refusal: an unknown criterion, a malformed line, a
   duplicate criterion, or a rubric with no criteria at all is an error that names the line —
   never a skipped line, never a default weight.

3. **The criteria vocabulary is four, each mechanically computed** from the proposal subject.
   The tool imposes no rubric, but it can only weigh what it can derive — a criterion it cannot
   compute would be a dress-up opinion, which this product does not emit.

   | criterion    | computed from                                          | 1      | 2      | 3    |
   | ------------ | ------------------------------------------------------ | ------ | ------ | ---- |
   | `severity`   | the finding's tier (a class: its worst)                | polish | gap    | risk |
   | `economy`    | remaining effort (a class: its most expensive member)  | L      | M      | S    |
   | `confidence` | the finding's confidence (a class: its weakest member) | low    | medium | high |
   | `breadth`    | personal projects carrying it                          | 1      | 2      | ≥3   |

   A class is scored conservatively — worst tier, worst effort, weakest confidence — because a
   proposal must not overstate an opportunity to win rank. `breadth` of a single finding is 1:
   cross-project reach is the class subject's job, and the two families stay independent.

4. **Score = Σ weight × value** over the rubric's criteria. A rubric line **fires** for a
   proposal when the subject's value is at or above the criterion's midpoint (≥ 2 of 3) — the
   record carries `matched`, the lines that argued for it, each with its computed value.

5. **Proposal subjects, all corp-free:** every finding with `kind: "improvement"` from every
   personal-profile project, plus every recurring class recomputed over personal projects only
   (the ≥2-projects rule unchanged). Corp entries are excluded from the output entire — a
   corp improvement is the employer's backlog, not this fleet's proposal queue — and their
   exclusion is disclosed by name. Wall findings are never subjects: they carry no `kind`, and
   fleet-scope conditions are not improvement opinions.

6. **The record is `proposal/1`** (experimental through 0.2.x with the rest of the fleet
   family):

   ```jsonc
   {
     "id": "alpha:context-economy/heavy-file:AGENTS.md",   // <project>:<finding id>
     "schema": "proposal/1",
     "class": "context-economy/heavy-file",                 // the engine-minted class prefix
     "kind": "finding" | "class",                           // "class" ids are `class:<classId>`
     "projects": ["alpha"],
     "action": "Extract the reference bulk into an on-demand skill/doc and keep a pointer.",
     "effort": "M", "confidence": "high",
     "score": 9,
     "matched": [{ "criterion": "severity", "weight": 3, "value": 2 }],
     "implications": {
       "projects": ["alpha"],
       "files": ["AGENTS.md"],
       "gates": [],
       "reversibility": "git-reversible"
     }
   }
   ```

   A class record's `action` is its member findings' distinct actions, sorted and joined with
   `; ` — usually one, never invented.

7. **The `implications` block is computed from the findings' evidence**, heuristically and
   disclosed as such: `files` are the path-shaped leading tokens of evidence lines (a token up
   to the first whitespace or `:`, kept when it contains `/` or looks like `name.ext` — prose
   evidence yields nothing); `gates` are those files under `.githooks/` or
   `.github/workflows/`, the two gate surfaces this tool knows; `reversibility` is
   `regenerable` when every file sits in a tool-generated zone (`.etymd/`, `.githooks/`),
   `git-reversible` when files are committed content, `undetermined` when no path was
   extracted — never a guess dressed as a fact. Paths stay repo-relative as the findings cite
   them; `projects` names the repos they sit in.

8. **Ranking is score descending, then id ascending** — fully determined by content, so the
   order is stable across identical inputs.

## Rejected

- A default rubric or built-in weights: the tool would be imposing one fleet's priorities on
  every other user — the exact failure the founding fitness test exists to prevent.
- Free-text criteria the fleet invents: nothing mechanical could compute them, so the "score"
  would be a language model's opinion wearing a number. An unknown criterion is refused, named.
- Scoring truth findings: a lie is not an opportunity; it is fixed, not ranked. Only
  `kind: "improvement"` findings and recurring classes become proposals.
- Including corp findings with a flag: a corp worktree's backlog leaving the machine under any
  flag is the wrong default; corp proposals do not exist in this command's world.
- A cutoff/threshold flag: gating is the consumer's call (the filing flow reads the score);
  the command scores and emits, it does not decide what passes.

## Verify

`etymd propose --manifest <fixture-registry> --rubric <rubric> --json | jq '.proposals | length'`
is ≥ 1 on the test fixture; running it twice yields identical output; a rubric line naming an
unknown criterion exits non-zero quoting the line. Pinned in `test/propose.test.ts`.
