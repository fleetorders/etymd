import { createHash } from "node:crypto"

import type { GateConfig } from "../core/config.js"
import type { PackageManager, ProjectFacts } from "../core/types.js"
import { PACK_VERSION } from "./version.js"

/**
 * The generation stamp — the line that tells a stale gate apart from a customised one.
 *
 * Without it, "the file on disk is not what the pack would write" has two causes with opposite
 * correct responses: a human customised it (never clobber), or the repo's own inputs moved on —
 * a renamed script, a changed package manager, an older pack — and the file is now a gate that
 * no longer matches the repo (regenerate). Treating both as hand-edited preserves the broken
 * one, and the only escape is deleting the file, which nobody would think to try.
 *
 * A stamp turns the guess into a proof. The digest covers the file MINUS this line, so a file
 * that still hashes to its own stamp is byte-for-byte what etymd wrote and cannot contain
 * anyone's work; any edit, including to the stamp itself, breaks the match and the file is
 * treated as hand-authored again. Absent stamp = unknowable, and unknowable is kept.
 *
 * This does not reopen the "marked region" question that generation deliberately avoids: the
 * stamp is pack-owned output, regenerated with the file and never a place to write anything.
 * The repo's own text still lives in the `.local` companion, which etymd does not read or write.
 */
const GENERATION_MARKER_RE = /^(?:# |<!-- )etymd:generated pack-v\S+ ([0-9a-f]{16})(?: -->)?$/

function digestOf(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16)
}

/**
 * Append the stamp. Deterministic: the same body always yields the same bytes.
 *
 * The comment syntax is the file's, not ours — a stamp that renders as text in the artifact it
 * describes is a defect in the artifact. Shell scripts take `#`, markdown takes an HTML comment.
 */
export function stampGenerated(body: string, comment: "sh" | "md" = "sh"): string {
  const marker = `etymd:generated pack-v${PACK_VERSION} ${digestOf(body)}`
  return `${body}${comment === "md" ? `<!-- ${marker} -->` : `# ${marker}`}\n`
}

export type FileOrigin =
  /** Byte-for-byte etymd's own output — safe to regenerate, holds nobody's work. */
  | "pack"
  /** Stamped, but the bytes moved since — someone edited it. Never clobber. */
  | "edited"
  /** No stamp: hand-written, or generated before stamping existed. Unknowable, so kept. */
  | "unstamped"

/**
 * The stamp is written last, but it is searched for ANYWHERE — an edit that appends below it is
 * still an edit, and pinning the search to the final line would read that file as unstamped and
 * report a known hand-edit as merely unknowable. Whichever line it is, removing it must
 * reconstruct the exact bytes that were hashed, or the file is not ours to overwrite.
 */
export function fileOrigin(text: string): FileOrigin {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = GENERATION_MARKER_RE.exec(lines[i] as string)
    if (!match) continue
    const body = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n")
    return digestOf(body) === match[1] ? "pack" : "edited"
  }
  return "unstamped"
}

export function runPrefix(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm"
    case "yarn":
      return "yarn"
    case "bun":
      return "bun run"
    case "npm":
    case "unknown":
    default:
      // npm is the safe universal fallback when no lockfile pins the manager.
      return "npm run"
  }
}

/** A command wired into a correctness gate must never write, fix, or generate. */
export function isSafeGateCommand(value: string | undefined): boolean {
  if (!value) return false
  return !/--write|--fix|\bcodegen\b|\bgenerate\b|-w\s|--watch/.test(value)
}

/** How to re-verify the repo map against reality — the map is advisory, never authoritative. */
export function mapVerifyCommand(facts: ProjectFacts): string {
  switch (facts.workspace.kind) {
    case "nx":
      return `${facts.packageManager === "yarn" ? "yarn" : "npx"} nx show projects`
    case "pnpm":
      return "pnpm -r ls --depth -1"
    case "yarn":
      return "yarn workspaces info"
    case "npm":
      return "npm ls --workspaces --depth=0"
    case "turbo":
    case "lerna":
      return "git ls-files '*/package.json'"
    default:
      return "git ls-files | head -50"
  }
}

function doneDefinition(facts: ProjectFacts): string[] {
  const run = runPrefix(facts.packageManager)
  const parts: string[] = []
  const c = facts.commands
  const formatCmd =
    c.formatCheck ??
    (isSafeGateCommand(c.format ? c.raw[c.format] : undefined) ? c.format : undefined)
  if (formatCmd) parts.push(`\`${run} ${formatCmd}\``)
  if (c.typecheck) parts.push(`\`${run} ${c.typecheck}\``)
  if (c.lint) parts.push(`\`${run} ${c.lint}\``)
  if (c.test) parts.push(`\`${run} ${c.test}\``)
  return parts
}

/**
 * The minimal AGENTS.md scaffold — only what the scan can assert truthfully, plus clearly
 * marked slots for the human/agent to complete. etymd audits this file afterwards, so the
 * template must never claim what it cannot know.
 */
export function generateAgentsMd(facts: ProjectFacts): string {
  // Stamped like every other generated file. It carries the pack version the bare
  // `<!-- etymd pack vN -->` comment used to, and answers the question that comment could not:
  // whether anyone has filled this contract in yet, or it is still untouched boilerplate.
  const run = runPrefix(facts.packageManager)
  const done = doneDefinition(facts)
  // "none detected" stays true with or without a manifest; "see package.json" lied in docs-only
  // repos where that file does not exist (the docs-only onboarding case, 2026-07-26).
  const frameworks = facts.frameworks.length ? facts.frameworks.join(", ") : "none detected"
  const workspace =
    facts.workspace.kind === "none" ? "single package" : `${facts.workspace.kind} workspace`
  const topDirs = facts.tree.dirs.slice(0, 14)

  return stampGenerated(
    `# AGENTS.md

Operating contract for AI agents working in **${facts.name}**. One source of truth — most agents
(Claude Code, Codex, Cursor, Copilot, Gemini, …) read this file natively. Kept true by
[etymd](https://www.npmjs.com/package/etymd): the commands, paths, and claims below are audited
against the actual repo — update this file when the repo changes, or \`etymd audit\` will tell you.

## What this project is

<!-- One paragraph: what this does and who it is for. Run \`etymd brief\` to have your agent
draft it from the reckoning; refine by hand. -->

## Stack

- **Shape:** ${workspace}${facts.packages.length ? ` (${facts.packages.length} packages)` : ""}, package manager **${facts.packageManager}**${facts.node ? `, Node ${facts.node}` : ""}.
- **Frameworks:** ${frameworks}.
- **CI:** ${facts.ci.system === "none" ? "none detected" : facts.ci.system}.

## Working rules

- **Reuse-first.** Before writing any new helper/component/type: check the map below and the
  surrounding code — a "new" thing usually exists.
- **Minimal diffs.** Never touch files outside the task's scope.
<!-- Add your project's own rules: commit/branch conventions, what the agent may and may not do,
org tooling constraints. Keep every rule TRUE — stale rules erode trust in the rest. -->

## Repo map

> **Advisory, not authoritative** — re-verify with \`${mapVerifyCommand(facts)}\` before
> structure-sensitive changes, and update this section in the same change that moves files.

${topDirs.length ? topDirs.map((d) => `- \`${d.name}/\` — ${d.files} files`).join("\n") : "- (single package; list the key files here)"}

## Done =

${done.length ? `A change is done when these are green:\n\n${done.map((d) => `- ${d}`).join("\n")}` : `Define the check commands that gate a change (test / lint / typecheck / format).`}

## Commands

\`\`\`bash
${
  [
    facts.commands.dev && `${run} ${facts.commands.dev}`,
    facts.commands.build && `${run} ${facts.commands.build}`,
    facts.commands.test && `${run} ${facts.commands.test}`,
    facts.commands.lint && `${run} ${facts.commands.lint}`,
    facts.commands.typecheck && `${run} ${facts.commands.typecheck}`,
  ]
    .filter(Boolean)
    .join("\n") || "# add the project's key commands"
}
\`\`\`

`,
    "md",
  )
}

/** The package name this pack ships as — the key that decides the dev-build arm below. */
const SELF_PACKAGE_NAME = "etymd"

/**
 * Is generation running in the repo that develops the screener itself?
 *
 * Keyed on the MANIFEST name, never on `facts.name` alone: that field falls back to the
 * directory basename when no `package.json` exists, and a directory that merely happens to be
 * called `etymd` is not this package. `publishRoute` is the scan's record of whether a root
 * manifest was read at all — `"none"` means there was none.
 */
export function isSelfBuildRepo(facts: ProjectFacts): boolean {
  return facts.publishRoute !== "none" && facts.name === SELF_PACKAGE_NAME
}

/**
 * The content screen is DECLARED here and RESOLVED at run time from an external checker, which
 * is what lets a generated hook be committed to a public repo safely: the hook holds no
 * patterns, and a machine without a checker installed runs a no-op instead of failing.
 *
 * The indirection is the whole design. Screening patterns are the very strings being screened
 * for (organisation names, hostnames, identities), so they can never live in a tracked file — the
 * hook names an executable, and the executable reads the pattern file. Etymd ships the screener
 * (`etymd screen`) but never ships patterns: the mechanism is general, the policy is the user's.
 *
 * Resolution order, everywhere: an explicit CONTENT_GATE, then whatever `etymd` is on PATH.
 *
 * In this package's OWN repo — and only there, decided at generation time from the manifest
 * name — one step is inserted between them, for the dogfood case: a repo developing the
 * screener has to gate on its own unreleased build, or its hooks enforce the last PUBLISHED
 * behaviour against a tree that has already moved past it (observed: a renamed allow file the
 * published binary could not read, silently voiding every exemption).
 *
 * That step was previously emitted into EVERY repo as a bare `[ -x ./dist/cli.js ]` existence
 * check — and `dist/cli.js` is simply where a great many CLI projects build. Any such repo had
 * its hook resolve the screener to ITS OWN binary, which does not know `screen`: the commit
 * door then failed closed on every commit, while the push door — which ignores the screen's
 * exit status by design — skipped the whole-tree pass in silence, the worse of the two. The
 * trap armed itself on a plain dependency install, since that runs the repo's build. Deciding
 * at generation time is what keeps the arm out of every repo it cannot be true for; a repo that
 * needs a different runner for one invocation still has CONTENT_GATE.
 */
function contentGateResolution(selfBuild: boolean): string {
  if (!selfBuild) return `GATE="\${CONTENT_GATE:-$(command -v etymd || true)}"`
  return `GATE="\${CONTENT_GATE:-$(if [ -x ./dist/cli.js ]; then echo ./dist/cli.js; else command -v etymd || true; fi)}"`
}

/**
 * A screen call that explains itself when the runner turns out not to be a screener.
 *
 * `screen` arrived in etymd 0.11, and the resolution above can also land on whatever a person
 * pointed the override at. Either way the runner answers with its own bare "unknown command",
 * which names no cause and no way out — at the moment a commit is blocked. That is the same
 * shape of unexplained gate failure this pack exists to prevent, so the hook says the one thing
 * the runner cannot.
 *
 * The probe runs ONLY after a failure, so a clean run pays nothing for it, and it is what
 * separates the two cases sharing an exit code: a screener reporting a real finding (it has
 * already spoken — add nothing) and a runner that never understood the subcommand at all.
 */
function contentScreenCall(opts: {
  args: string
  envVar: string
  blocking: boolean
  indent: string
}): string {
  const { args, envVar, blocking, indent } = opts
  const hint = `etymd: this checker does not understand 'screen' (needs etymd 0.11+) — upgrade it, or set ${envVar} to a checker that does.`
  return [
    `${indent}if ! "$GATE" screen ${args}; then`,
    `${indent}  "$GATE" screen --help >/dev/null 2>&1 ||`,
    `${indent}    echo "${hint}" >&2`,
    ...(blocking ? [`${indent}  exit 1`] : []),
    `${indent}fi`,
  ].join("\n")
}

/**
 * The seam between what the pack owns and what the repo owns.
 *
 * A generated file that cannot hold anything local forces a false choice: accept the pack and
 * lose your own checks, or hand-maintain the file and lose regeneration. Both were observed in
 * real repos — one carries a bespoke archive guard, another documents why its audit tier differs
 * from every sibling — and regenerating either would have destroyed working, reasoned work.
 *
 * So the pack owns the whole generated file and simply CALLS a companion it never reads or
 * writes. Two files, two owners, one convention. Deliberately not a marked region inside the
 * generated file: drift detection is exact byte equality, so any hand-written text living in the
 * compared file destroys the ability to tell a tampered gate from an edited note, and would make
 * the tool parse its own output forever.
 *
 * Delete the companion and its checks stop running — which is what deleting a file means. Etymd
 * does not police a file it does not own.
 */
function localHookCall(hook: string, feedRefs = false): string {
  // pre-push alone receives the pushed refs on stdin, and the shell gate below reads them too —
  // whichever consumed stdin directly would starve the other, so they are captured once and fed
  // to each.
  const refsCapture = feedRefs
    ? `# git hands the pushed refs to pre-push ONCE, on stdin — one line per ref:
# "<local ref> <local sha> <remote ref> <remote sha>". The shell gate below reads them too, so
# they are captured here and fed to each.
refs=$(cat)
`
    : ""
  const call = feedRefs
    ? `printf '%s\\n' "$refs" | "$LOCAL" "$@" || exit 1`
    : `"$LOCAL" "$@" || exit 1`
  return `# Repo-owned checks. This file is generated and will be overwritten; \`.githooks/${hook}.local\`
# is yours — etymd never reads, writes, or regenerates it. Put project-specific guards there.
# A guard running tests that build fixture repositories should scrub git's exported GIT_* names
# first — a child git inherits them and ignores its cwd, so the suite would hit the real repo:
#   env $(env | grep -o '^GIT_[A-Za-z0-9_]*' | sed 's/^/-u /') <your command>
LOCAL="$(dirname "$0")/${hook}.local"
${refsCapture}if [ -x "$LOCAL" ]; then
  ${call}
fi`
}

export function generatePreCommitHook(selfBuild = false): string {
  return stampGenerated(`#!/usr/bin/env sh
# etymd: process gate. Cheap, locally-knowable checks belong here (fast, blocks the commit).

${localHookCall("pre-commit")}

# Content screen — staged file bytes. Refuses to commit detail about your environment, work
# or identity into a repo whose history is (or could become) public. The checker and its
# patterns are machine-local by design, so this is a NO-OP wherever no checker is installed:
# safe to commit anywhere, active only where you opted in.
#
# Bypass, with a reason: git commit --no-verify
${contentGateResolution(selfBuild)}
if [ -x "$GATE" ]; then
${contentScreenCall({ args: "--staged", envVar: "CONTENT_GATE", blocking: true, indent: "  " })}
fi

exit 0
`)
}

/** The subject forms a convention gates can read, and a person can read. */
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const

/** Beyond this a subject stops fitting a `git log --oneline` column. Advice, never a block. */
export const SUBJECT_ADVISORY_LENGTH = 72

/**
 * Conventional Commits, checked at the only door that sees a message. Emitted ONLY where
 * `gates.commitFormat` is explicitly true — see the caller.
 *
 * This is a FORMAT check and deliberately not a taste check: it reads the first non-comment
 * line and asks whether a machine can classify it, nothing more. The distinction matters
 * because the gate that argues about wording is the gate everyone learns to bypass — and the
 * bypass flag is shared with the screen above, which must never be bypassed.
 *
 * It earns its keep where a repo has chosen the convention, because a convention with no door
 * erodes without anyone deciding to abandon it: histories drift one hurried commit at a time,
 * and nothing objects until the log is already mixed. That is an argument for offering the
 * door, never for installing it in a repo that did not ask.
 *
 * Merge, revert, fixup, squash and amend subjects are git's own wording rather than the
 * author's — gating them would ask people to rewrite text they did not write.
 */
function commitFormatStep(): string {
  const types = COMMIT_TYPES.join("|")
  return `
# Message format — <type>[(scope)][!]: <summary>. Needs nothing installed, so it always runs.
subject=$(sed -e '/^#/d' -e '/^[[:space:]]*$/d' "$1" | head -1)
case "$subject" in
  "Merge "*|"Revert "*|fixup!*|squash!*|amend!*) ;;
  *)
    if ! printf '%s' "$subject" | grep -qE '^(${types})(\\([a-z0-9._/-]+\\))?!?: .+'; then
      echo "✗ commit message: expected '<type>[(scope)][!]: <summary>'"
      echo "  got:   $subject"
      echo "  types: ${COMMIT_TYPES.join(" ")}"
      echo "  a '!' after the type or scope marks a breaking change"
      exit 1
    fi
    # Length is advice, not a block: the format is what tooling reads, the length is what a
    # person reads, and only one of the two can break anything.
    if [ "\${#subject}" -gt ${SUBJECT_ADVISORY_LENGTH} ]; then
      echo "› note: subject is \${#subject} characters; ${SUBJECT_ADVISORY_LENGTH} or fewer reads better in git log"
    fi
    ;;
esac`
}

/**
 * The message is published history too, and the staged screen cannot see it: that gate reads
 * `git diff --cached`, which is file bytes only. A real audit found several leaks living in
 * commit messages rather than files, which is why this is its own door.
 */
export function generateCommitMsgHook(gates?: GateConfig): string {
  // Unset means OFF, and only an explicit `true` turns it on. A convention is an opinion, and
  // the pack does not hold opinions on a user's behalf — a repo that never asked for this must
  // get the same hook it got before the check existed.
  const format = gates?.commitFormat === true ? `${commitFormatStep()}\n` : ""
  return stampGenerated(`#!/usr/bin/env sh
# etymd: the commit message itself — content screen, then format.
#
# The staged-content gate reads file bytes and never sees the message, yet a message is as
# permanently published as any file. No-op where no checker is installed.
#
# Bypass, with a reason: git commit --no-verify
GATE="\${COMMIT_MSG_GATE:-$(command -v etymd || true)}"
if [ -x "$GATE" ]; then
${contentScreenCall({ args: '--message "$1"', envVar: "COMMIT_MSG_GATE", blocking: true, indent: "  " })}
fi
${format}
${localHookCall("commit-msg")}

exit 0
`)
}

/**
 * The correctness gate for a repo whose executable surface is shell.
 *
 * Five properties, each a lesson from a gate that failed:
 *
 * The check reads the scripts CHANGED BY THE COMMITS BEING PUSHED, each at the commit that
 * changed it — never the working tree (a fixed tree let an unfixed commit ship while the
 * gate read the tree, and a dirty tree shared by several sessions blocked an unrelated
 * push), and never the tip alone (a bad commit under its own fix shipped while the gate
 * read only the tip). A range or a change that cannot be enumerated refuses the push:
 * certifying bytes the gate did not read is the one thing this gate must never do. A script
 * no pushed commit touched was gated when it landed — the same argument the range
 * enumeration already makes for commits a remote received — so a push of N commits that
 * each change one script reads N scripts, not N whole trees per commit.
 *
 * A commit with no readable first parent (a root, or a graft the object store cannot show)
 * falls back to every script in its own tree: with no parent, the whole tree is the change.
 * A merge is read through its combined diff — only paths whose merged bytes differ from
 * EVERY parent; a path that matches one parent arrived with that parent's own commit, where
 * this same push reads it (or the remote that already has it did, when it landed).
 *
 * A changed path that is not a readable regular file — a submodule gitlink, a symlink — is
 * a counted, disclosed skip, never a refused push. The gate cannot read those bytes as a
 * script; a gate that bricked every push of every repo with one such path would be
 * uninstalled, and then nothing is checked.
 *
 * A missing `shellcheck` is a LOUD skip naming the install command. A check that goes quiet
 * when its binary is absent is the worst kind — the repo looks guarded on every machine,
 * and is guarded on one.
 *
 * The blocking bar is `warning`; style and info print as advice AFTER the blocking pass,
 * once for the whole push over each script at its last-changing commit — not once per
 * commit over every script, which multiplied a push's checker time and output noise by its
 * commit count. Discarding the sub-warning findings instead of showing them would be the
 * opposite mistake: the cheap ones are how a script gets better between defects.
 */
function shellcheckStep(): string {
  return `
# Shell correctness. The scripts CHANGED BY THE PUSHED COMMITS are the bytes that may ship,
# so each one is read at the commit that changed it — never the working tree (wrong in both
# directions: a fixed tree let an unfixed commit ship, and a dirty tree shared by several
# sessions blocked an unrelated push) and never the tip alone (a bad commit under a clean tip
# shipped while the gate read the tip's fix). A script no pushed commit touched was gated
# when it landed — the argument the range enumeration below already makes for whole commits —
# so a push of many small commits reads many small file sets, not the whole tree per commit.
# zsh is NOT in the checked set: the checker
# cannot parse it (SC1071 is a parser-level error no inline directive can silence), so checking
# it would fail every push on the parser, not on the script. Excluded — and said so at run
# time below, because a coverage hole that is silent is indistinguishable from coverage.
#
# "the checker", not its name, on purpose: a comment whose first word is that name is read as
# a DIRECTIVE, and an unparseable directive is itself an error (SC1072/SC1073). A hook that
# explains why it skips a shell dialect must not break the checker while doing it.
if command -v shellcheck >/dev/null 2>&1; then
  (
    # The subshell confines cleanup to this step; nothing is deleted inside the loops.
    shellcheck_tmp=$(mktemp -d) || exit 1
    trap 'rm -rf "$shellcheck_tmp"' 0
    trap 'exit 1' 1 2 3 15
    # Every commit in each pushed range, never the tip alone: pushing two commits — a bad
    # script, then its fix — passed a tip-only read while the bad commit landed on the remote.
    # An all-zero local sha is a delete (nothing to check). An all-zero REMOTE sha is a new
    # branch: everything no remote already has is being pushed, so the range is the local sha
    # minus every remote-tracking ref — commits a remote already received were gated when they
    # landed there, and the residue is exactly this push's new commits. Enumeration failure
    # refuses the push: a range the gate could not list is a range it did not read.
    # (pattern) with both parens: bash 3.2 (macOS /bin/sh) cannot parse an unbalanced )
    # in a case pattern.
    : > "$shellcheck_tmp/shas" || exit 1
    printf '%s\\n' "$refs" | while read -r _lref lsha _rref rsha; do
      case "$lsha" in
        (*[!0]*) ;;
        (*) continue ;;
      esac
      case "$rsha" in
        (*[!0]*) git rev-list "$rsha..$lsha" ;;
        (*) git rev-list "$lsha" --not --remotes ;;
      esac >> "$shellcheck_tmp/shas" || exit 1
    done || {
      echo "✗ shellcheck: could not enumerate the commits being pushed" >&2
      exit 1
    }
    # Deduped IN ORDER: rev-list is newest-first, and the advice pass must know each script's
    # last-changing commit — only an order-preserving walk can.
    shas=$(awk '!seen[$0]++' "$shellcheck_tmp/shas") || exit 1
    [ -n "$shas" ] || echo "› shellcheck: no commit in the pushed refs (deletes only, or nothing on stdin) — nothing to check"
    mkdir -p "$shellcheck_tmp/lists.d" "$shellcheck_tmp/adv.d" || exit 1
    : > "$shellcheck_tmp/gap-count" && : > "$shellcheck_tmp/zsh-count" && : > "$shellcheck_tmp/pairindex" && : > "$shellcheck_tmp/seen" || exit 1
    for sha in $shas; do
      short=$(git rev-parse --short "$sha" 2>/dev/null || echo "$sha")
      tree=$(git rev-parse -q --verify "$sha^{tree}") || {
        echo "✗ shellcheck: could not resolve the tree of $short — refusing the push rather than certifying bytes this gate did not read" >&2
        exit 1
      }
      # The scripts this commit changed, each with its destination mode: diff-tree's raw
      # records alternate META and PATH as separate NUL fields, so a path keeps its whitespace,
      # quotes, leading hyphens, even newlines unchanged. --diff-filter drops deletions
      # (nothing to read) and keeps adds, copies, modifications, renames (an undetected rename
      # is a delete plus an add, and the add side is kept) and type changes; a mode-only
      # change is a modification. A MERGE is read through its combined diff instead — paths
      # whose merged bytes differ from EVERY parent — because a path matching one parent
      # arrived with that parent's own commit, where this same push reads it (or the remote
      # that already has it did, when it landed there). A commit with no readable first
      # parent — a root, or a graft the object store cannot show — is read whole: with no
      # parent, the entire tree is this commit's change.
      if git rev-parse -q --verify "$sha^2" >/dev/null 2>&1; then
        git diff-tree --no-commit-id --raw -z -r --cc "$sha" > "$shellcheck_tmp/names" 2>/dev/null || {
          echo "✗ shellcheck: could not enumerate the changes of $short — refusing the push rather than certifying bytes this gate did not read" >&2
          exit 1
        }
      elif git rev-parse -q --verify "$sha^" >/dev/null 2>&1; then
        git diff-tree --no-commit-id --raw -z -r --diff-filter=ACMRT "$sha" > "$shellcheck_tmp/names" 2>/dev/null || {
          echo "✗ shellcheck: could not enumerate the changes of $short — refusing the push rather than certifying bytes this gate did not read" >&2
          exit 1
        }
      else
        echo "› shellcheck: commit $short has no readable first parent — reading every script in its tree"
        git diff-tree --no-commit-id --raw -z -r --root --diff-filter=ACMRT "$sha" > "$shellcheck_tmp/names" 2>/dev/null || {
          echo "✗ shellcheck: could not enumerate the changes of $short — refusing the push rather than certifying bytes this gate did not read" >&2
          exit 1
        }
      fi
      : > "$shellcheck_tmp/scripts-this" || exit 1
      xargs -0 sh -c '
        work=$1
        sha=$2
        tree=$3
        short=$4
        shift 4
        while [ $# -ge 2 ]; do
          meta=$1
          path=$2
          shift 2
          # The destination mode is the second field of the raw record: ":<src mode> <dst mode> …"
          rest=\${meta#* }
          mode=\${rest%% *}
          case "$mode" in
            160000|120000)
              printf . >> "$work/gap-count" || exit 1
              continue
              ;;
          esac
          mkdir -p "$work/t/$tree" || exit 1
          case "$path" in
            */*) mkdir -p "$work/t/$tree/\${path%/*}" || exit 1 ;;
          esac
          if ! git show "$sha:$path" > "$work/t/$tree/$path" 2>/dev/null; then
            exit 1
          fi
          head -n 1 "$work/t/$tree/$path" > "$work/first-line" || exit 1
          if grep -qE "^#!.*[/ ](ba|da)?sh( |$)" "$work/first-line"; then
            printf "./%s\\0" "$path" >> "$work/lists.d/$tree" || exit 1
            printf "%s %s\\n" "$tree" "$path" >> "$work/pairindex" || exit 1
            printf . >> "$work/scripts-this" || exit 1
            # Newest commit first, so the FIRST push of a script into the advice set carries
            # its final state in this push — advice runs once, over each script as it last
            # ships. (Line-exact matching: a path containing a newline never matches and may
            # be advised once per changing commit — advice duplication only, never a skip.)
            if ! grep -Fqx -- "$path" "$work/seen"; then
              printf "%s\\n" "$path" >> "$work/seen" || exit 1
              printf "./%s\\0" "$path" >> "$work/adv.d/$tree" || exit 1
            fi
          else
            [ "$?" -eq 1 ] || exit 1
            if grep -qE "^#!.*[/ ]zsh( |$)" "$work/first-line"; then
              printf . >> "$work/zsh-count" || exit 1
            else
              [ "$?" -eq 1 ] || exit 1
            fi
          fi
        done
      ' sh "$shellcheck_tmp" "$sha" "$tree" "$short" < "$shellcheck_tmp/names" || {
        echo "✗ shellcheck: script discovery failed; coverage is incomplete" >&2
        exit 1
      }
      scripts_this=$(wc -c < "$shellcheck_tmp/scripts-this") || exit 1
      if [ "$scripts_this" -gt 0 ]; then
        echo "› shellcheck: commit $short changed $scripts_this shell script(s)"
      else
        echo "› shellcheck: commit $short changed no shell script — nothing read for it"
      fi
    done
    if [ -n "$shas" ]; then
      commit_count=$(printf '%s\\n' "$shas" | grep -c .) || exit 1
      # grep -c prints 0 even as it exits 1 on zero matches, so || true keeps a scriptless
      # push at zero instead of failing closed on an empty pairindex.
      pair_count=$(sort -u "$shellcheck_tmp/pairindex" | grep -c . || true)
      echo "› shellcheck: $((commit_count)) commit(s) in the push, $((pair_count)) changed script file(s) to check, blocking at severity=warning"
    fi
    gap_count=$(wc -c < "$shellcheck_tmp/gap-count") || exit 1
    zsh_count=$(wc -c < "$shellcheck_tmp/zsh-count") || exit 1
    if [ "$gap_count" -gt 0 ]; then
      echo "› shellcheck: $((gap_count)) changed path(s) are not readable regular files — submodule gitlink or symlink; not read, not checked"
    fi
    if [ "$zsh_count" -gt 0 ]; then
      echo "› shellcheck: $((zsh_count)) zsh script(s) excluded — shellcheck cannot parse zsh (SC1071); not checked, not failed"
    fi
    for lst in "$shellcheck_tmp"/lists.d/*; do
      [ -f "$lst" ] || continue
      tree_id=\${lst##*/}
      sort -zu "$lst" > "$shellcheck_tmp/blocking" || exit 1
      n=$(tr '\\0' '\\n' < "$shellcheck_tmp/blocking" | grep -c .) || exit 1
      echo "› shellcheck: $((n)) script(s) as of tree $(git rev-parse --short "$tree_id" 2>/dev/null || echo "$tree_id")"
      ( cd "$shellcheck_tmp/t/$tree_id" && xargs -0 shellcheck -S warning -- < "$shellcheck_tmp/blocking" ) || {
        echo "  fix, or justify inline with '# shellcheck disable=SCxxxx  # why'"
        exit 1
      }
    done
    # Everything below the blocking bar, shown once the push is already cleared — once for
    # the whole push, never once per commit. Never affects the exit code: advice that can
    # fail a push is not advice.
    : > "$shellcheck_tmp/advice-all" || exit 1
    for adv in "$shellcheck_tmp"/adv.d/*; do
      [ -f "$adv" ] || continue
      tree_id=\${adv##*/}
      sort -zu "$adv" > "$shellcheck_tmp/advising" || exit 1
      ( cd "$shellcheck_tmp/t/$tree_id" && xargs -0 shellcheck -S style -f gcc -- < "$shellcheck_tmp/advising" 2>/dev/null ) >> "$shellcheck_tmp/advice-all" || true
    done
    advice=$(grep -v ': warning:\\|: error:' "$shellcheck_tmp/advice-all" || true)
    if [ -n "$advice" ]; then
      echo "  · style/info (not blocking):"
      printf '%s\\n' "$advice" | sed 's/^/    /'
    fi
  ) || exit 1
else
  echo "› shellcheck skipped (not on PATH) — install it to gate this repo's shell scripts"
fi`
}

/**
 * Runs a gate step with git's hook environment scrubbed.
 *
 * Git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / … to every hook it runs, and a child
 * git that inherits them IGNORES ITS CWD. A test suite that builds fixture repositories by
 * shelling out to git therefore operates on the REAL repository — committing into it, moving
 * its refs — while the same suite outside a hook is harmless. Any gate step can shell out to
 * git (a test command above all, but a format or lint script may ask git for its file list
 * too), so every step runs scrubbed, uniformly.
 *
 * The scrub strips EVERY exported GIT_* name, not a fixed list — git adds variables over time,
 * and a name the list missed is the whole defect back. A step that genuinely means this
 * repository finds it again from its working directory, which for a hook is the repo root.
 * The shellcheck step is deliberately NOT routed through it: its git enumerations must see
 * the real repo the push runs from. The audit step IS routed through it: it runs inside a
 * materialised worktree of the pushed tip, where a child git inheriting git's exported
 * names would ignore the worktree it stands in and read the pushing checkout instead.
 */
const SCRUBBED_RUNNER = `
# Gate steps run scrubbed of git's exported GIT_* names: a child git that inherits them ignores
# its cwd, so a hook-run suite building fixture repositories would operate on the real repo.
run_gate() (
  # shellcheck disable=SC2046  # word-splitting is the point: one -u per exported GIT_* name
  env $(env | grep -o '^GIT_[A-Za-z0-9_]*' | sed 's/^/-u /') "$@"
)
`

export function generatePrePushHook(
  facts: ProjectFacts,
  gates?: GateConfig,
  selfBuild = false,
): string {
  const run = runPrefix(facts.packageManager)
  const c = facts.commands
  // A recorded command set wins over the derivation: the guess is a starting point, and the one
  // edit that changes it must survive the next `etymd gates` run.
  // Optional chaining on `commands` too: a hand-written config may set only `failOn`, and the
  // type claims the field is required while real input often omits it.
  const candidates = gates?.commands?.length ? gates.commands : [c.formatCheck, c.typecheck, c.lint]
  const allowed = new Set(gates?.allowWriting ?? [])
  const steps = candidates
    .filter(
      (key): key is string =>
        Boolean(key) && (allowed.has(key as string) || isSafeGateCommand(c.raw[key as string])),
    )
    .map((key) => `${run} ${key}`)
  const shellStep = facts.shell?.scripts ? shellcheckStep() : ""
  // Emitted unconditionally: the package steps call it, and so does the audit step below,
  // which must run scrubbed inside its materialised worktree even in a repo with no scripts.
  const runner = SCRUBBED_RUNNER
  const body = steps.length
    ? steps.map((s) => `echo "› ${s}"\nrun_gate ${s} || exit 1`).join("\n")
    : shellStep
      ? // A repo whose executable surface is shell HAS a correctness command — it just is not in
        // package.json. Claiming "none detected" beside a step that is about to run would be the
        // tool contradicting itself.
        'echo "› no package scripts — shell is this repo\'s checkable surface"'
      : 'echo "etymd: no correctness commands detected — add format:check / typecheck / lint"'
  // The truth gate on the repo's own instructions, at the tier this repo chose — read at the
  // TIP OF EACH PUSHED REF, materialised as a detached worktree of that commit, never at the
  // checkout the push happens to run from (wrong in both directions: a clean branch was
  // refused for a gap living only in the pushing checkout's working tree, and a branch
  // carrying a gap shipped because that checkout happened to be clean). Skipped with a note
  // rather than failing where etymd is not installed — a gate that cannot run must say so
  // instead of silently passing.
  const failOn = gates?.failOn ?? "risk"
  const auditStep = `
# The truth gate reads the bytes BEING PUSHED: each pushed tip is materialised as a detached
# worktree of its own commit and audited there, the same subject rule the shell gate above
# applies. hooksPath is neutralised for the materialisation itself so no hook of the pushed
# tree runs as a side effect of this read; the audit inside sees the repo's own config. It
# runs scrubbed (run_gate): a child git inheriting git's exported names would ignore the
# worktree it stands in. A push that carries no commits (deletes only) audits nothing, and
# says so.
if command -v etymd >/dev/null 2>&1; then
  (
    audit_tmp=$(mktemp -d) || exit 1
    trap 'rm -rf "$audit_tmp"' 0
    trap 'exit 1' 1 2 3 15
    : > "$audit_tmp/tips" || exit 1
    printf '%s\\n' "$refs" | while read -r _lref lsha _rref rsha; do
      case "$lsha" in
        (*[!0]*) ;;
        (*) continue ;;
      esac
      if [ "$lsha" != "$rsha" ]; then
        printf '%s\\n' "$lsha" >> "$audit_tmp/tips"
      fi
    done || exit 1
    tips=$(sort -u "$audit_tmp/tips") || exit 1
    [ -n "$tips" ] || echo "› etymd audit: no commit in the pushed refs (deletes only, or nothing new) — nothing to audit"
    for tip in $tips; do
      wt=$(mktemp -d "$audit_tmp/tip.XXXXXX") || exit 1
      if ! git -c core.hooksPath=/dev/null worktree add --detach -q "$wt" "$tip" 2>/dev/null; then
        echo "✗ etymd audit: could not materialise $(git rev-parse --short "$tip" 2>/dev/null || echo "$tip") for the audit — refusing the push rather than certifying bytes this gate did not read" >&2
        exit 1
      fi
      echo "› etymd audit --no-ledger --fail-on ${failOn} (at $(git rev-parse --short "$tip" 2>/dev/null || echo "$tip"), the pushed tip)"
      if ! (cd "$wt" && run_gate etymd audit --no-ledger --fail-on ${failOn}); then
        exit 1
      fi
      git -c core.hooksPath=/dev/null worktree remove --force "$wt" >/dev/null 2>&1 || exit 1
    done
  ) || exit 1
else
  echo "› etymd audit skipped (not on PATH)"
fi`
  return stampGenerated(`#!/usr/bin/env sh
# etymd: correctness gate. Mirrors CI cheapest-first; blocks the push on any failure.

${localHookCall("pre-push", true)}${runner}
${body}${shellStep}
${auditStep}

# Content screen, second pass — the WHOLE TREE rather than one diff. Catches anything committed
# with --no-verify and anything a rebase or merge brought in from elsewhere. Advisory here (it
# never blocks the push): the blocking decision belongs at commit time, where the fix is cheap.
${contentGateResolution(selfBuild)}
if [ -x "$GATE" ]; then
${contentScreenCall({ args: "--tree --advisory", envVar: "CONTENT_GATE", blocking: false, indent: "  " })}
fi

exit 0
`)
}

/**
 * The publish door — the only check that inspects what actually SHIPS.
 *
 * Every git-scoped check answers "what is in the repository?". That question misses the leak
 * that reaches users: a gitignored file can be packaged into a published artifact (npm and vsce
 * do not honour .gitignore), so every git-based gate passes forever while the bytes go out.
 * This builds what the project would publish, unpacks it, and screens the result.
 */
export function generateArtifactCheckScript(selfBuild = false): string {
  return stampGenerated(`#!/usr/bin/env sh
# etymd: content screen — the published ARTIFACT, not the repository.
#
# Wire it into the irreversible moment:
#   package.json → "prepublishOnly": "./scripts/artifact-check.sh"
#
# The artifact gate is the one check that sees what actually SHIPS — bypass with
# .etymd-screen-allow entries (with provenance) if you must exempt a string.
set -eu

${contentGateResolution(selfBuild)}
[ -x "$GATE" ] || { echo "› artifact-check: no checker installed — skipping."; exit 0; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# Pack exactly what would ship, then screen the unpacked bytes.
if [ -f package.json ]; then
  npm pack --pack-destination "$WORK" >/dev/null 2>&1 || {
    echo "› artifact-check: npm pack failed — cannot verify what would ship" >&2; exit 1; }
  tar -xzf "$WORK"/*.tgz -C "$WORK" 2>/dev/null || true
fi

${contentScreenCall({ args: '--dir "$WORK"', envVar: "CONTENT_GATE", blocking: true, indent: "" })}
exit 0
`)
}
