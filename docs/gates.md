# Gates: CI, local hooks and the content screen

## In CI

The gate is one command:

```bash
npx etymd audit --no-ledger --fail-on risk
```

Exit-code contract: without `--fail-on`, `audit` reports and exits 0 no matter what it found.
With `--fail-on <tier>` (`risk` | `gap` | `polish`) it exits non-zero when any finding at or
above that tier exists, so `--fail-on risk` blocks on risks only and `--fail-on polish` blocks on
everything. `--no-ledger` keeps the CI run read-only: the throwaway checkout is never written.

The ledger and baseline are not CI by-products. They are **committed, reviewable state**,
updated locally and read in CI. A dismissal (with its reason), an accepted finding, a baseline
refresh after an intentional restructure: each lands in `.etymd/` and shows up in the pull
request diff like any other change. Keep `.etymd` out of your formatter's reach (see
[configuration](https://github.com/fleetorders/etymd/blob/main/docs/configuration.md)).

A check that runs only in CI is itself a finding: the failure shows up after the agent finished.
`etymd gates` installs the local pre-commit / pre-push mirror built from your own check scripts,
and from the repo's shell scripts, which usually have no check of their own, while the
`gate-integrity` lens flags whatever still runs in CI alone.

Modeled on this repo's own workflow (its CI runs the same gate against its own freshly built
CLI):

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 20
      cache: npm
  - run: npm ci
  - run: npx etymd audit --no-ledger --fail-on risk
```

## Your own checks, beside the generated ones

Generated hooks are overwritten on every `etymd gates` run, so nothing hand-written belongs in
them. Each one calls a companion instead (`.githooks/pre-commit.local`, `commit-msg.local`,
`pre-push.local`) that etymd **never reads, writes or regenerates**. Make it executable and it
runs; a non-zero exit stops the commit or push exactly as the generated checks do.

> **Commit the companion, and check your `.gitignore` first.** A `*.local` rule, common for env
> files and shipped by some framework templates, silently swallows these too. The guard then
> works on the machine that wrote it and is absent for everyone who clones, which looks identical
> to having no guard at all. Add `!.githooks/*.local` if that rule exists.

```sh
cat > .githooks/pre-commit.local <<'EOF'
#!/usr/bin/env sh
# Whatever this project needs; etymd will not touch this file.
./scripts/check-changelog.sh || exit 1
EOF
chmod +x .githooks/pre-commit.local
```

Two files, two owners. The generated half stays byte-identical to what the templates produce,
which is what lets drift detection say something precise: a difference there means the
_managed_ part was edited or went stale, never that you added a check of your own. Delete the
companion and its checks stop running; etymd does not police a file it does not own.

## The shell scripts

Package scripts are not the only executable surface a repo has, and in some repos they are not
the main one: a tools or infra repo can be entirely `bootstrap/*.sh` plus `.githooks/*` with no
`package.json` at all. Where a repo has tracked shell scripts, the generated pre-push carries a
`shellcheck` step. Three properties are deliberate:

- **Scripts are re-discovered by shebang at push time**, never baked into the hook as a list. A
  generated list is correct the day it is written and silently wrong the first time someone adds
  a script.
- **A missing `shellcheck` binary is a loud skip that names the install command**, never a quiet
  pass. A check that goes silent when its tool is absent looks installed on every machine and is
  installed on one.
- **Only `warning` severity and above blocks**; style and info print as advice afterwards. A gate
  with a high false-positive rate teaches everyone the bypass flag, and that flag is shared with
  the checks that must never be bypassed.

## The content screen (`etymd screen`)

A separate question from "are the instructions true?": **does this repo carry text that must
never be published?** Absolute home paths, an organisation's name, an internal hostname, an
account identifier: permanent the moment they are committed, because publishing exposes all
history, not the current tree.

Etymd ships the mechanism and **no patterns, ever**. The strings worth screening for are
themselves the sensitive material, so a built-in list would be useless to everyone else and a
leak for whoever wrote it. You supply a pattern file (one regex or literal per line, `#` for
comments) at `~/.config/etymd/screen-patterns` or via `--patterns`. Without one the command is
inert and says so; it never reports "clean" for a check it did not run.

`etymd gates` wires it into four hooks, because a leak walks through whichever is unguarded:

| hook             | scope               | what only it can catch                                        |
| ---------------- | ------------------- | ------------------------------------------------------------- |
| `pre-commit`     | staged file bytes   | the ordinary case, at the cheapest moment to fix              |
| `commit-msg`     | the message itself  | the staged scan reads file bytes and never sees the message   |
| `pre-push`       | every tracked file  | anything committed with `--no-verify`, or merged in from else |
| `prepublishOnly` | the packed artifact | **a gitignored file that still ships**                        |

That last hook exists because the first three share a blind spot: they all answer "what is in
the repository?". `npm` and `vsce` do not honour `.gitignore`, so a local cache file can be
packaged into a published release while every git-scoped check passes forever.

Every generated hook resolves the screener at run time and **no-ops when it is absent**, so the
same hook file is safe to commit to a public repo: it carries no patterns and imposes no policy
on anyone who clones it. A deliberate exception on a line you can edit is marked inline with
`allow-published-string`, visible in the diff.

Some exemptions cannot live on the line itself: a scanner's own source contains the strings it
screens for, its tests contain fixtures that must match, and a bundler strips comments so an
inline marker would not survive into the artifact. Those live in `.etymd-screen-allow` at the
repo root, one labeled line per field, so the pattern is never delimited:

```
pattern ^AcmeInc|BetaInc$
reason fixture proving the detector fires on either name
date 2026-08-15
author someone
```

A pattern may contain any character, including the `|` shown above, without escaping: labels
move the field boundary to the line break, which the field cannot contain. An entry naming the
repo itself needs no provenance; a bare `^widget$` line is a complete record. Anything else
missing a field is reported and does not apply: an exemption is a hole in the gate, and a hole
nobody signed cannot be audited later. The file is read from the repo being screened, never a
shared location, and it screens itself out (it necessarily contains every string it exempts).

The file carries a second record kind, for paths rather than lines:

```
generated ^src/data/words\.json$
reason public-domain word list, regenerated by scripts/words each January
date 2026-09-04
author someone
```

A `generated` path is data a pipeline rebuilds, and such data trips credential vocabulary
(`passkey`, `secret`) on a schedule, training exactly the `--no-verify` habit the screen exists
to prevent. The file is still read and still screened: only vocabulary-class patterns drop for
it, while secret-class patterns and the machine-path check stay, because a generated file is
precisely where a real credential would be least visible. Provenance is unconditional (a path is
never the repo naming itself), and the paths that took the exemption are named in the output, so
a clean run never reads as fully screened where it was screened narrower.

## The commit subject, if you ask for it

Off unless you turn it on:

```json
{ "gates": { "commitFormat": true } }
```

in `.etymd/config.json`. Then the `commit-msg` hook also checks the subject against
[Conventional Commits](https://www.conventionalcommits.org): `<type>[(scope)][!]: <summary>`,
with `feat fix docs style refactor perf test build ci chore revert` as the types. It is a format
check and not a taste check: it asks whether a machine can classify the line, and stops there.
An over-long subject is reported as advice and never blocks, and the subjects git writes for you
(merge, revert, fixup, squash, amend) are exempt, since gating those would ask you to rewrite
text you did not write.

It is the one generated check that needs nothing installed, and therefore the one that would run
for everyone who clones your repo. That is exactly why it is off by default. Every other check
the generated hooks carry is either derived from what your repo already does or inert without a
checker you installed yourself; a commit convention is neither. It is an opinion, and this tool
does not hold opinions on your behalf. Turn it on where the convention is already yours.
