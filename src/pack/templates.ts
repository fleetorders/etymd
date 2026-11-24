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
  // repos where that file does not exist.
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

/**
 * The Claude Code pointer — the adapter that makes one contract readable by every harness.
 *
 * Claude Code auto-discovers `CLAUDE.md` and follows its `@` imports. From 2.1.277 it also reads
 * `AGENTS.md` when a directory has no `CLAUDE.md`; older releases never load it, so a repo whose
 * instructions live only in `AGENTS.md` is skipped by them. This pointer keeps those readers
 * covered, and it is a pack artifact so `fleet add` can print the exact bytes it wants and
 * `init` can scaffold the same thing where the local reader still needs it.
 */
export function generateClaudePointerMd(): string {
  return stampGenerated(
    `# CLAUDE.md

Single source of truth for agent instructions lives in \`AGENTS.md\`. This pointer keeps Claude
Code aligned with every other agent — edit \`AGENTS.md\`, not this file.

@AGENTS.md

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
 * behaviour against a tree that has already moved past it (for example, a renamed allow file the
 * published binary could not read, silently voiding every exemption).
 *
 * A bare `[ -x ./dist/cli.js ]` check must never be emitted into other repos: `dist/cli.js` is
 * where many CLI projects build, and such a repo's hook would resolve the screener to its own
 * binary, which does not know `screen`. The commit hook then fails closed on every commit while
 * the push hook, which ignores the screen's exit status by design, skips its whole-tree pass in
 * silence. Deciding at generation time keeps that step out of every repo it cannot be true for;
 * a repo that needs a different runner for one invocation still has CONTENT_GATE.
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
 * The executable check around a screen door, with the honesty rule attached: set-but-unusable
 * is a DIFFERENT silence from "no checker installed". An override naming a missing or
 * non-executable path used to skip the door with no output at all — indistinguishable from
 * the deliberate no-op of a machine with no checker, so a misconfigured override passed for a
 * choice. From pack 23 one stderr line separated them, but the door still opened, and a hook
 * that passes shows its stderr to nobody in a GUI client — so a typo in the one variable set
 * to TIGHTEN the gate turned it off unseen. The door refuses from pack 28: the variable was set
 * on purpose, the line names the path and the two ways out, and an unset override stays the
 * silent no-op it always was. The way out names any screen-capable checker, not etymd alone:
 * the override exists precisely so a person can point it at a checker of their own.
 */
function gateDoor(hook: string, envVar: string, what: string, inner: string): string {
  return [
    `if [ -x "$GATE" ]; then`,
    inner,
    `elif [ -n "\${${envVar}:-}" ]; then`,
    `  echo "${unusableOverride(hook, envVar)} (${what} refused)" >&2`,
    `  exit 1`,
    `fi`,
  ].join("\n")
}

function unusableOverride(hook: string, envVar: string): string {
  return `${hook}: ${envVar} is set but not usable: $GATE — point it at an executable checker that understands 'screen', or unset it`
}

/**
 * pre-push's content screen is advisory — its findings never block — yet the set-but-unusable
 * override still refuses (pack 28, above). The two must not share wording: "advisory screen
 * refused" under a comment promising the screen never blocks read as the hook contradicting
 * itself. So the refusal names itself a configuration error, and it runs FIRST, before the
 * local guard, the package steps, the shell gate and the materialised audit: the override's
 * usability is known before any of them start, and a typo should cost seconds, not the whole
 * push. The screen at the end then only opens or stays a silent no-op.
 */
function prePushContentGatePreflight(selfBuild: boolean): string {
  return `# The content screen at the end of this hook is advisory — its findings never block the push —
# but an override set to something unusable is a configuration error, and that refuses. Checked
# here, before every long step, so a typo costs seconds rather than the whole push.
${contentGateResolution(selfBuild)}
if [ ! -x "$GATE" ] && [ -n "\${CONTENT_GATE:-}" ]; then
  echo "${unusableOverride("pre-push", "CONTENT_GATE")} (a configuration error refuses the push; the advisory screen's own findings never do)" >&2
  exit 1
fi`
}

/**
 * The seam between what the pack owns and what the repo owns.
 *
 * A generated file that cannot hold anything local forces a false choice: accept the pack and
 * lose your own checks, or hand-maintain the file and lose regeneration. Real repos carry
 * both: a bespoke guard here, a documented audit tier there; regenerating either would destroy
 * working, reasoned work.
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
# they are captured here and fed to each. stdin is read only when it is NOT a terminal: git
# always pipes the refs, but a hand run of this hook from a terminal would leave the read
# waiting on a keyboard that never sends EOF — a long silent hang. A terminal run reads no
# refs and says so; the steps below then report nothing to check.
if [ -t 0 ]; then
  refs=""
  echo "› no pushed refs — terminal stdin (a manual run?); git feeds the refs only on a real push"
else
  refs=$(cat)
fi
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
${gateDoor(
  "pre-commit",
  "CONTENT_GATE",
  "staged screen",
  contentScreenCall({ args: "--staged", envVar: "CONTENT_GATE", blocking: true, indent: "  " }),
)}

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
 * Conventional Commits, checked at the only hook that sees a message. Emitted ONLY where
 * `gates.commitFormat` is explicitly true — see the caller.
 *
 * This is a FORMAT check and deliberately not a taste check: it reads the first non-comment
 * line and asks whether a machine can classify it, nothing more. The distinction matters
 * because the gate that argues about wording is the gate everyone learns to bypass — and the
 * bypass flag is shared with the screen above, which must never be bypassed.
 *
 * It earns its keep where a repo has chosen the convention, because a convention with no gate
 * erodes without anyone deciding to abandon it: histories drift one hurried commit at a time,
 * and nothing objects until the log is already mixed. That is an argument for offering the
 * check, never for installing it in a repo that did not ask.
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
 * `git diff --cached`, which is file bytes only. Leaks live in commit
 * messages as readily as in files, which is why this is its own hook.
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
${gateDoor(
  "commit-msg",
  "COMMIT_MSG_GATE",
  "message screen",
  contentScreenCall({
    args: '--message "$1"',
    envVar: "COMMIT_MSG_GATE",
    blocking: true,
    indent: "  ",
  }),
)}
${format}
${localHookCall("commit-msg")}

exit 0
`)
}

/**
 * How git reaches the gates at all — the one fact a plain clone cannot recover from the files
 * themselves. `etymd gates` sets `core.hooksPath` to `.githooks`, and that setting lives in the
 * machine's git config, not the repo: on a fresh clone the committed hooks sit inert and the
 * push gate looks unreachable rather than uninstalled (observed in review). Markdown, stamped
 * like the hooks so regeneration treats it as pack-owned; a hand-written README is kept like
 * any other unstamped file.
 *
 * The blank line before the stamp is load-bearing: prettier's markdown formatter separates a
 * trailing block-level HTML comment from the paragraph above it, so a consumer running
 * `prettier --check .` over a fresh install fails on this file without it — and "fixing" the
 * format by hand breaks the stamp's digest, which reclassifies the file as hand-edited and
 * silently freezes it out of every later regeneration. The file is emitted in the one shape
 * the formatter and the stamp agree on, whichever side of the formatter's blank-line
 * behavior a consumer runs.
 */
export function generateHooksReadme(): string {
  return stampGenerated(
    `# How git reaches these hooks

Everything in this directory except the \`*.local\` guards is etymd's generated gate pack,
this README included (see the \`etymd:generated\` stamps at the end of each file). \`etymd gates\`
installs the pack and points git at it by setting \`core.hooksPath\` to \`.githooks\` — that
setting is machine-local, which is why git runs these hooks in this checkout and not in a plain
clone; there they sit inert until \`etymd gates\` runs again or you set \`core.hooksPath\` by
hand. Of the checks inside, only the \`screen\` calls need etymd — the shell correctness and
audit checks in \`pre-push\` need nothing but their tools being on PATH. Where no checker is
installed (\`CONTENT_GATE\` and \`COMMIT_MSG_GATE\` unset, no etymd on PATH) the screens are
silent no-ops by design and the commit passes; only an override that is set but does not point
at an executable checker is loud, and it refuses. A later \`etymd gates\` run overwrites the
generated files (it asks before clobbering hand-edited ones, and a hand-edited file it keeps
stops receiving fixes), so fixes to any of them, this one included, belong upstream in etymd's
pack; your own guards go in \`pre-push.local\`, \`pre-commit.local\` or \`commit-msg.local\`,
which etymd never reads, writes or regenerates.

`,
    "md",
  )
}

/**
 * The pre-push shell classifier, as a tracked file of its own.
 *
 * This is the most intricate code the pack emits — the match/error protocol that treats a
 * "no match" grep status as a verdict but a higher one as the matcher failing, the
 * one-dot-per-decision tallies a dying pipeline cannot fake, the NUL-delimited handoff. Inside
 * the hook it lived in a single-quoted `sh -c` string: one string argument to xargs, invisible
 * to the shellcheck pass the hook itself runs, so the part of the gate most worth linting was
 * the only part no linter ever saw. As a shebanged file beside the hook it is discovered by the
 * scan it implements the moment the gates are committed — the gate checks its own classifier,
 * and a defect here blocks the push instead of shipping silently inside it.
 *
 * Invoked as `xargs -0 <this file> <scratch-dir>` with the tracked paths as the remaining
 * positional arguments — never `-I{}`, which interpolates filenames into shell code. xargs may
 * split a large file set into several invocations; the scratch tallies stay correct only while
 * those run one batch at a time, so nothing here may ever run them in parallel.
 */
export function generateShellDiscoveryScript(): string {
  return stampGenerated(`#!/usr/bin/env sh
# etymd: shell script discovery for the pre-push shellcheck step. Four calls per commit:
#   discover-shell-scripts.sh --config <scratch> <tree> <ls-tree record>...
#   discover-shell-scripts.sh --skips <scratch> <ls-tree record>...
#   discover-shell-scripts.sh --commit <scratch> <tree> <commit> <commit>:<path>...
#   discover-shell-scripts.sh --context <scratch> <tree> <ls-tree record>...
# --config writes the commit's .shellcheckrc files into the tree as raw blobs, so the checker
# finds its config where it looks, and flags one that turns external-sources on. --skips counts
# the changed paths that are symlinks or submodule entries. --commit reads the candidates
# \`git grep\` found with a line starting \`#!\`, and classifies each by its FIRST line. Verdicts
# land in the scratch: scripts (NUL-delimited matches) and one dot per decision into count /
# zsh-count / other-count / skip-count, tallied by the hook after the pipeline. Each script found is written
# into <tree> at its path, so the checker reads it there. With external-sources on, --context
# then stages, as raw blobs, the files the staged scripts source.
#
# Every byte comes from git's object store as the raw blob — \`git cat-file blob\`, which
# applies no eol, text or filter attribute. A checkout converts: under \`eol=crlf\` the shebang
# line ends in a carriage return, the match below fails, and the script leaves the checked set
# without a word. Only the entries handed in are read, never the whole commit.
#
# A symlink or submodule entry has no script bytes of its own — a link's target is a tracked
# path checked under its own name — so it is a disclosed skip, never a block. A candidate that
# cannot be read fails, naming the path: coverage would otherwise silently shrink.
#
# The match/error protocol: grep reports "no match" as 1 and a failure as 2 or more, and only
# the first is a verdict. Letting a failure fall through would pass a broken matcher as "not a
# shell script" — the exact silent coverage-shrink the fail-closed rules exist to prevent. The
# status is captured on the grep's own line (\`|| st=$?\`), so no command added later can come
# between the grep and the check and silently replace the status being read.
tab=$(printf '\\t')
case \${1-} in
  (--skips)
    # Records only: a symlink or submodule entry is counted, everything else is left to the
    # candidate pass. Builtins only — this loop sees every changed path.
    work=$2
    shift 2
    for record do
      case \${record%% *} in
        (100644|100755) ;;
        (*) printf . >> "$work/skip-count" || exit 1 ;;
      esac
    done
    exit 0 ;;
  (--config)
    # Every entry of the commit, of which only .shellcheckrc files are kept — builtins decide,
    # so the whole listing costs no process per path. Each is written into the tree as its raw
    # blob, where the checker looks for it, and one turning external-sources on is flagged.
    work=$2
    tree=$3
    shift 3
    for record do
      meta=\${record%%"$tab"*}
      file=\${record#*"$tab"}
      # A record path must stay inside the tree before anything consumes it: git's own
      # writers refuse a tree entry whose name carries .., but a hand-forged or corrupted
      # object reaches ls-tree verbatim, and an escaping name writes outside the tree.
      case $file in
        (""|/*|.|..|./*|../*|*/..|*/../*|*/.|*/./*)
          echo "etymd: tracked path does not stay inside the checked tree: $file" >&2
          exit 1 ;;
      esac
      case $file in
        (.shellcheckrc|*/.shellcheckrc) ;;
        (*) continue ;;
      esac
      case \${meta%% *} in
        (100644|100755) ;;
        (*) continue ;;
      esac
      case $file in
        (*/*) dir=\${file%/*} ;;
        (*) dir=. ;;
      esac
      mkdir -p -- "$tree/$dir" && git cat-file blob "\${meta##* }" > "$tree/$file" || {
        echo "etymd: cannot read tracked file for shellcheck: $file" >&2
        exit 1
      }
      st=0
      grep -qE '^[[:space:]]*external-sources[[:space:]]*=[[:space:]]*true' "$tree/$file" || st=$?
      case $st in
        (0) : > "$work/external-sources" || exit 1 ;;
        (1) ;;
        (*) exit 1 ;;
      esac
    done
    exit 0 ;;
  (--context)
    # Records again, for external sources: a regular entry whose file name is among the names
    # the staged files source (scratch/source-names, one per line) is written into the tree as
    # its raw blob, unless the tree has it already. Matching by name over-stages at worst, and
    # a raw blob runs no checkout filter — an unrelated file's filter can never refuse the push.
    work=$2
    tree=$3
    shift 3
    nl='
'
    names="$nl$(cat "$work/source-names")$nl" || exit 1
    for record do
      meta=\${record%%"$tab"*}
      file=\${record#*"$tab"}
      # The same staying-inside guard as --config: the path is consumed below (mkdir, the
      # blob write) before any later filter can be trusted to neutralise it.
      case $file in
        (""|/*|.|..|./*|../*|*/..|*/../*|*/.|*/./*)
          echo "etymd: tracked path does not stay inside the checked tree: $file" >&2
          exit 1 ;;
      esac
      case \${meta%% *} in
        (100644|100755) ;;
        (*) continue ;;
      esac
      case $names in
        (*"$nl\${file##*/}$nl"*) ;;
        (*) continue ;;
      esac
      [ -e "$tree/$file" ] && continue
      case $file in
        (*/*) dir=\${file%/*} ;;
        (*) dir=. ;;
      esac
      mkdir -p -- "$tree/$dir" && git cat-file blob "\${meta##* }" > "$tree/$file" || {
        echo "etymd: cannot read tracked file for shellcheck: $file" >&2
        exit 1
      }
    done
    exit 0 ;;
  (--commit)
    [ $# -ge 4 ] || exit 1 ;;
  (*)
    echo "etymd: discover-shell-scripts.sh expects --commit, --skips, --config or --context; the pre-push beside it is older than this classifier — run 'etymd gates'" >&2
    exit 1 ;;
esac
work=$2
tree=$3
sha=$4
shift 4
for entry do
  file=\${entry#"$sha":}
  # The path is consumed below (the blob read, the mv into the tree): the same
  # staying-inside guard as the other arms, checked before any byte moves.
  case $file in
    (""|/*|.|..|./*|../*|*/..|*/../*|*/.|*/./*)
      echo "etymd: tracked path does not stay inside the checked tree: $file" >&2
      exit 1 ;;
  esac
  # 4096 bytes bound the classifying read — a binary with no newline would otherwise be copied
  # whole into the next step. The second head restores line-1-only semantics, so a shebang
  # embedded on a LATER line of a document cannot match the patterns below.
  git cat-file blob "$sha:$file" > "$work/blob" && head -c 4096 "$work/blob" > "$work/head-bytes" || {
    echo "etymd: cannot read tracked file for shellcheck: $file" >&2
    exit 1
  }
  head -n 1 "$work/head-bytes" > "$work/first-line" || exit 1
  # The interpreter is read ONCE, as a name: the first word after #! with its directory
  # stripped, or — where that word is env — the first word after env's own options and NAME=value
  # settings (env -S bash -e is bash), or — where it is busybox — the applet it runs. One name,
  # one case below, so a versioned or suffixed build (bash5, zsh-5.9) lands in its family
  # instead of slipping past three near-duplicate patterns. Spaces, tabs and a trailing carriage
  # return all separate words: a tab before a flag (sh<TAB>-e) or a first line committed with
  # CRLF must still classify, or the script leaves every bucket — unchecked, unexcluded,
  # undisclosed. LC_ALL=C: the line is bytes, possibly not text in the caller's locale. A first
  # line with no shebang prints nothing.
  interp=$(LC_ALL=C awk 'NR == 1 {
      if (substr($0, 1, 2) != "#!") exit
      line = substr($0, 3)
      gsub(/[\\t\\r]/, " ", line)
      n = split(line, w, " ")
      i = 1
      name = w[1]
      sub(/.*\\//, "", name)
      if (name == "env") {
        for (i = 2; i <= n; i++) {
          if (w[i] == "-u" || w[i] == "--unset" || w[i] == "-C" || w[i] == "--chdir" || w[i] == "-P") { i++; continue }
          if (w[i] ~ /^-/ || w[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) continue
          break
        }
        name = (i <= n) ? w[i] : ""
        sub(/.*\\//, "", name)
      }
      if (name == "busybox") name = (i + 1 <= n) ? w[i + 1] : ""
      print name
      exit
    }' "$work/first-line") || exit 1
  case $interp in
    (sh|bash|dash|sh[0-9]*|bash[0-9]*|dash[0-9]*|sh-[0-9]*|bash-[0-9]*|dash-[0-9]*)
      case $file in
        (*/*) dir=\${file%/*} ;;
        (*) dir=. ;;
      esac
      mkdir -p -- "$tree/$dir" && mv -- "$work/blob" "$tree/$file" || {
        echo "etymd: cannot stage tracked file for shellcheck: $file" >&2
        exit 1
      }
      printf "./%s\\0" "$file" >> "$work/scripts" || exit 1
      printf . >> "$work/count" || exit 1 ;;
    (zsh|zsh[0-9]*|zsh-[0-9]*)
      printf . >> "$work/zsh-count" || exit 1 ;;
    (ksh|ksh[0-9]*|ksh-[0-9]*|mksh|pdksh|oksh|lksh|ash|yash|posh|csh|tcsh|fish)
      # Another shell is a script this gate cannot check; it gets its own bucket, announced by
      # the hook like the zsh exclusion — a coverage hole that is silent is indistinguishable
      # from coverage.
      printf . >> "$work/other-count" || exit 1 ;;
    (*)
      # No shebang (data), or an interpreter that is not a shell at all (node, python3, ruby,
      # perl, deno …): not a shell script, so no bucket and no announcement — counting every
      # Node or Python tool as a shell coverage hole printed a standing line pushers learned to
      # ignore, the opposite of what an announced hole is for.
      ;;
  esac
done
`)
}

/**
 * The correctness gate for a repo whose executable surface is shell.
 *
 * Four properties, each a lesson from a gate that failed:
 *
 * Scripts are re-discovered HERE, at push time, by shebang over tracked files — never baked in as
 * a list. A generated list is correct on the day it is written and wrong the first time someone
 * adds a script, and the failure is silent: the new file is simply never checked. The classifier
 * doing that discovery is itself a tracked, shebanged file (see `generateShellDiscoveryScript`),
 * so the scan finds it too once the gates are committed — the gate covers its own classifier.
 *
 * The check reads the commits BEING PUSHED, each script read as its raw blob from git's object store — never
 * the working tree (a fixed tree let an unfixed commit ship while the gate read the
 * tree, and uncommitted edits in the tree blocked an unrelated push), and never the
 * tip alone (a bad commit under its own fix shipped while the gate read only the tip). A
 * commit or blob that cannot be read refuses the push: certifying bytes the gate did not read
 * is the one thing this gate must never do.
 *
 * Discovery fails closed only where coverage could silently shrink: failed enumeration, and a
 * regular file that exists but cannot be read, block the push. A tracked path with nothing
 * readable behind it — a submodule entry, a dangling symlink — cannot lie about its contents,
 * so it is counted and disclosed as skipped instead of blocking.
 *
 * A missing `shellcheck` is a LOUD skip naming the install command. A check that goes quiet when
 * its binary is absent is the worst kind — the repo looks guarded on every machine, and is
 * guarded on one.
 *
 * The blocking bar is `warning`; style and info print as advice AFTER the blocking pass. A gate
 * with a high false-positive rate does not make a repo careful, it teaches everyone the bypass
 * flag — and the flag is shared with the gates that must never be bypassed. Discarding the
 * sub-warning findings instead of showing them would be the opposite mistake: the cheap ones are
 * how a script gets better between defects, and they ride along free: one run at the widest
 * severity yields the verdict and the advice together.
 */
function shellcheckStep(): string {
  return `
# Shell correctness. Scripts are discovered by shebang over TRACKED files at push time, so a
# script added later is covered without regenerating this hook. The commits BEING PUSHED are
# the bytes that ship, so each script is read as its raw blob from git's object store —
# never the working tree (wrong in both directions: a fixed tree let an unfixed commit ship, and
# uncommitted edits in the tree blocked an unrelated push) and never the tip alone (a
# bad commit under a clean tip shipped while the gate read only the tip's fix). The classifier
# is discover-shell-scripts.sh beside this hook — tracked and shebanged like what it classifies,
# so the scan it implements finds and checks it too. zsh is NOT in the checked set:
# the checker cannot parse it (SC1071 is a parser-level error no inline directive can silence),
# so checking it would fail every push on the parser, not on the script. Excluded — and said so
# at run time below, because a coverage hole that is silent is indistinguishable from coverage.
# Any other shell (ksh, ash) is the same shape: counted in its own bucket and said so below,
# never silently unread. A first line with no shebang, or a shebang naming an interpreter that is
# not a shell (node, python3), lands nowhere — not a shell script, so no coverage hole.
# The same honesty splits the unreadable: a regular file that exists but cannot be read blocks
# the push (coverage would otherwise silently shrink), while a tracked path with nothing readable
# behind it — a submodule entry, a dangling symlink — is counted and said so below as skipped,
# never a block.
#
# "the checker", not its name, on purpose: a comment whose first word is that name is read as
# a DIRECTIVE, and an unparseable directive is itself an error (SC1072/SC1073). A hook that
# explains why it skips a shell dialect must not break the checker while doing it.
if command -v shellcheck >/dev/null 2>&1; then
  (
    # POSIX pipelines report only the LAST command's status, so discovery tallies progress in
    # files — one dot per decision, counted with wc -c after the pipeline — rather than
    # streaming through it: a pipeline that dies halfway cannot then pass as complete coverage,
    # and the same tallies carry the counts to the reporting below. The classifier writes the
    # tallies; this half only reads them.
    # NUL delimiters preserve filenames; positional arguments avoid xargs -I size limits and
    # interpreting filenames as shell code (never -I{}). The subshell confines cleanup to
    # this step. The classifier itself is the tracked, shebanged helper beside this hook, so
    # the discovery it performs finds and checks it too — the gate covers its own classifier.
    shellcheck_tmp=$(mktemp -d) || exit 1
    trap 'rm -rf "$shellcheck_tmp"' 0
    trap 'exit 1' 1 2 3 15
    # Every commit in each pushed range, never the tip alone: pushing two commits — a bad
    # script, then its fix — passed a tip-only read while the bad commit landed on the remote.
    # An all-zero local sha is a delete (nothing to check). An all-zero REMOTE sha is a new
    # branch: everything the pushed-to remote does not already have is being pushed, so the
    # range is the local sha minus THAT remote's tracking refs — commits it already holds are
    # not re-read here. That is a cost bound, not a proof: a commit that reached the remote
    # ungated (pushed from a clone where these hooks sit inert, or with --no-verify) and was
    # fetched into this clone stays outside the range — a known gap that only checks running on
    # the remote's side (CI) can close. Commits only OTHER remotes hold were gated by nobody
    # (a fetch runs no hooks), so they stay in the range and are read here. $1 carries the
    # pushed-to remote's name, but a push can name a URL instead (git push <url>), and --remotes=<url>
    # matches no refs — it would negate nothing and check a fresh clone's entire history, the
    # exact cost blowup this range design exists to avoid — so the narrow bound applies only
    # where $1 names a remote this clone has configured; a URL push keeps the wide bound and
    # its old residue. A remote sha this clone has never seen (the remote moved on since the
    # last fetch) cannot bound a range, so it takes the same new-branch rule instead of
    # refusing a push the gate could have read. The same subtraction bounds the EXISTING-branch
    # range: a branch that merged the upstream drags commits a remote already holds into
    # "$rsha..$lsha", and each was re-checked at its own tree, where later fixes do not exist —
    # so that range is the local sha minus the remote sha AND the remote-tracking refs.
    # Enumeration failure refuses the push: a range
    # the gate could not list is a range it did not read.
    # (pattern) with both parens: bash 3.2 (macOS /bin/sh) cannot parse an unbalanced )
    # in a case pattern.
    # Resolved once, before the loop, from the same $1 git passed this hook.
    bound="--remotes"
    if git remote get-url "$1" >/dev/null 2>&1; then
      bound="--remotes=$1"
    fi
    : > "$shellcheck_tmp/shas" || exit 1
    printf '%s\\n' "$refs" | while read -r _lref lsha _rref rsha; do
      case "$lsha" in
        (*[!0]*) ;;
        (*) continue ;;
      esac
      case "$rsha" in
        (*[!0]*)
          if git cat-file -e "\${rsha}^{commit}" 2>/dev/null; then
            git rev-list "$lsha" --not "$rsha" "$bound"
          else
            git rev-list "$lsha" --not "$bound"
          fi ;;
        (*) git rev-list "$lsha" --not "$bound" ;;
      esac >> "$shellcheck_tmp/shas" || exit 1
    done || {
      echo "etymd: could not enumerate the commits being pushed for shellcheck" >&2
      exit 1
    }
    shas=$(sort -u "$shellcheck_tmp/shas") || exit 1
    if [ -n "$shas" ]; then
      # Said up front: a first push from a fresh clone can carry the whole history, and a long
      # silent hook reads as a hung one.
      echo "› shellcheck: $(printf '%s\\n' "$shas" | wc -l | tr -d ' ') commit(s) in the pushed range"
    else
      echo "› shellcheck: no commit in the pushed refs (deletes only, or nothing on stdin) — nothing to check"
    fi
    # Resolved once, before any cd: the checker runs inside each commit's scratch tree, and a
    # relative hook path would no longer point at it from there.
    discover="$(cd "$(dirname "$0")" && pwd)/discover-shell-scripts.sh" || exit 1
    # A checker upgrade can flag bytes nobody touched: a new shellcheck release adds checks
    # that fire on scripts already sitting on the remote, and the per-commit read below only
    # re-reads what a commit touches — those findings would wait for each script's next edit.
    # The checker's own version is stamped inside the git dir (never the working tree, so no
    # repo grows an untracked file for bookkeeping); when it moves, every commit of this push
    # is checked whole — once, after the change, not on every push as the old gate did. A
    # missing stamp is a first adoption, not a change (the adopting push is covered by the
    # gate-install trigger below); a stamp that cannot be read is doubt, and doubt points at
    # more checking. The new stamp is written only AFTER the checks pass: a refused or
    # interrupted push leaves the prior stamp in place, so the next push re-runs the
    # whole-tree read instead of trusting a re-baseline that never completed — a write that
    # cannot happen at all only means the next push re-checks whole again — never less
    # coverage.
    checker_stamp="$(git rev-parse --git-dir 2>/dev/null)/etymd-shellcheck-version"
    checker_ver=$(shellcheck --version 2>/dev/null | sed -n 's/^version: //p' | head -n 1)
    force_whole=0
    if [ -f "$checker_stamp" ]; then
      checker_old=$(cat "$checker_stamp" 2>/dev/null) || force_whole=1
      if [ "\${checker_old:-unknown}" != "\${checker_ver:-unknown}" ]; then
        force_whole=1
        echo "› shellcheck: the checker changed (\${checker_old:-unknown} → \${checker_ver:-unknown}) — re-checking the whole shell surface this push"
      fi
    fi
    # The verdict is parsed from gcc-format lines, so a format or severity override in
    # SHELLCHECK_OPTS would hand the gate output it cannot read while the exit status still
    # speaks: under '-f json' a real warning once sailed into the advice block and the push
    # passed, because the environment's -f replaces this command's own. Those two flag
    # classes are stripped from the options the gate runs with — every other option
    # (disable=, external-sources, source-path, …) passes through untouched — and the strip
    # is said out loud when it happens, because silently overriding the caller's environment
    # is how the hole got missed.
    sc_kept=""
    sc_dropped=0
    sc_prev=""
    # shellcheck disable=SC2086  # word-splitting is the point: one option token per word, as shellcheck reads them itself
    for sc_opt in \${SHELLCHECK_OPTS:-}; do
      case "$sc_opt" in
        (-f|-f*|-S|-S*|--format|--severity|--format=*|--severity=*)
          sc_dropped=1
          sc_prev="$sc_opt"
          ;;
        (*)
          case "$sc_prev" in
            (-f|--format|-S|--severity) ;;
            (*) sc_kept="$sc_kept $sc_opt" ;;
          esac
          sc_prev=""
          ;;
      esac
    done
    sc_kept=\${sc_kept# }
    if [ "$sc_dropped" -eq 1 ]; then
      echo "› shellcheck: format/severity override in SHELLCHECK_OPTS ignored — the verdict reads gcc format at style severity"
    fi
    for sha in $shas; do
      # A fresh directory per commit holding only that commit's scripts, removed once it is
      # checked; the subshell trap above still cleans the root on every early exit.
      tree=$(mktemp -d "$shellcheck_tmp/commit.XXXXXX") || exit 1
      if ! git cat-file -e "\${sha}^{commit}" 2>/dev/null; then
        echo "✗ shellcheck: cannot read commit $(git rev-parse --short "$sha" 2>/dev/null || echo "$sha") — refusing the push rather than certifying bytes this gate did not read" >&2
        exit 1
      fi
      : > "$shellcheck_tmp/scripts" && : > "$shellcheck_tmp/count" \\
        && : > "$shellcheck_tmp/zsh-count" && : > "$shellcheck_tmp/other-count" \\
        && : > "$shellcheck_tmp/skip-count" || exit 1
      # Only the paths this commit adds, copies, modifies, renames or retypes against its first
      # parent. A script the commit did not touch has its parent's bytes, and that parent was
      # either gated when it reached the remote or sits in this range and is checked here; a
      # merge diffed against its first parent brings in everything the other side added.
      # Checking every script in every commit multiplied the cost by the range length, so a long
      # push of a script-heavy repo ran long enough to look hung. Two changes alter the verdict
      # on bytes nobody touched — the classifier deciding what is a script, and a .shellcheckrc
      # deciding what is a finding — so a commit that touches either, deletion included (a
      # removed .shellcheckrc re-enables every check it disabled), is checked whole. So is a
      # commit that adds or changes this hook: a repo adopting the gate after the fact has
      # scripts no gate ever read, and the commit installing it is where they get read once.
      short=$(git rev-parse --short "$sha" 2>/dev/null || echo "$sha")
      # Two listings from one diff: the paths the commit adds, copies, modifies, renames or
      # retypes (the checked candidates), and the subset that is the gate, its classifier or a
      # .shellcheckrc, deletions included (the whole-tree trigger). The trigger is asked of git
      # by pathspec, never read out of the NUL-delimited list: the one place this hook turned
      # that list into lines, a tracked path holding a newline split into two records, and a
      # name ending in pre-push just before the newline passed for the gate. A leading **/ matches at
      # the root and at every depth. GIT_LITERAL_PATHSPECS, where a caller exports it, would
      # read the glob as a plain path and find nothing — the narrow path, in silence — so that
      # one call runs with it cleared.
      if git rev-parse -q --verify "\${sha}^1^{commit}" >/dev/null 2>&1; then
        git diff-tree -r -z --name-only --no-commit-id --diff-filter=ACMRT "\${sha}^1" "$sha" > "$shellcheck_tmp/tracked" \\
          && GIT_LITERAL_PATHSPECS='' git diff-tree -r -z --name-only --no-commit-id "\${sha}^1" "$sha" \\
            -- ':(glob)**/.shellcheckrc' ':(glob)**/discover-shell-scripts.sh' ':(glob)**/pre-push' > "$shellcheck_tmp/gate-touched"
      else
        git diff-tree -r -z --name-only --no-commit-id --root "$sha" > "$shellcheck_tmp/tracked" \\
          && GIT_LITERAL_PATHSPECS='' git diff-tree -r -z --name-only --no-commit-id --root "$sha" \\
            -- ':(glob)**/.shellcheckrc' ':(glob)**/discover-shell-scripts.sh' ':(glob)**/pre-push' > "$shellcheck_tmp/gate-touched"
      fi || {
        echo "etymd: cannot enumerate the paths $short changes for shellcheck" >&2
        exit 1
      }
      where="changed in $short"
      whole_reason=""
      if [ "$force_whole" -eq 1 ]; then
        whole_reason="the checker changed"
      elif [ -s "$shellcheck_tmp/gate-touched" ]; then
        whole_reason="the gate, its classifier or a .shellcheckrc changed"
      fi
      if [ -n "$whole_reason" ]; then
        where="in $short (whole tree: $whole_reason)"
        git ls-tree -r -z --name-only "$sha" > "$shellcheck_tmp/tracked" || {
          echo "etymd: cannot enumerate the tree of $short for shellcheck" >&2
          exit 1
        }
      fi
      # Only these paths are read, each as its raw blob — never a checkout of the commit, which
      # would apply eol and filter attributes (a CRLF shebang left the checked set silently) and
      # write the whole tree to check a handful of files. Never \`git archive\` either: it honours
      # export-ignore, so a script so marked would leave the set without a word.
      : > "$shellcheck_tmp/records" && : > "$shellcheck_tmp/candidates" || exit 1
      if [ -s "$shellcheck_tmp/tracked" ]; then
        # The candidates: changed blobs holding a line that starts \`#!\`, found in one pass over
        # the raw blobs (git grep reads no eol or filter conversion). Only these are read one by
        # one — a file with no such line cannot have a shebang first line. grep's "no match" is
        # 1, a verdict; xargs would fold it into a failure, so the wrapper maps 1 to 0 and lets
        # anything higher through as the failure it is.
        xargs -0 git --literal-pathspecs ls-tree -z "$sha" -- < "$shellcheck_tmp/tracked" > "$shellcheck_tmp/records" \\
          && xargs -0 sh -c 'git --literal-pathspecs grep -z -l --full-name -e "^#!" "$0" -- "$@"; st=$?; [ "$st" -le 1 ]' "$sha" \\
            < "$shellcheck_tmp/tracked" > "$shellcheck_tmp/candidates" || {
          echo "etymd: shell script discovery failed; cannot list the tracked entries of $short" >&2
          exit 1
        }
      fi
      # The checker's config sits beside the scripts it governs: every .shellcheckrc in the
      # commit, raw, and a flag when one turns external-sources on (handled after discovery).
      rm -f "$shellcheck_tmp/external-sources" || exit 1
      git ls-tree -r -z "$sha" > "$shellcheck_tmp/entries" \\
        && xargs -0 "$discover" --config "$shellcheck_tmp" "$tree" < "$shellcheck_tmp/entries" || {
        echo "etymd: shell script discovery failed; cannot read the .shellcheckrc files of $short" >&2
        exit 1
      }
      xargs -0 "$discover" --skips "$shellcheck_tmp" < "$shellcheck_tmp/records" \\
        && xargs -0 "$discover" --commit "$shellcheck_tmp" "$tree" "$sha" < "$shellcheck_tmp/candidates" || {
        echo "etymd: shell script discovery failed; shellcheck coverage is incomplete" >&2
        exit 1
      }
      # With external-sources on, the checker follows what scripts source — helpers with no
      # shebang, so no script — and a missing one turns its assignments into false findings.
      # The names sourced (a \`.\` or \`source\` argument, or a \`source=\` directive) are read from
      # the staged files and the matching entries staged as raw blobs, again until nothing new
      # is sourced, so a helper's own helpers are there too. A name built from a variable cannot
      # be followed by the checker either, so it is dropped. Never a checkout: that runs every
      # tracked file's filters, and an unrelated failing one would refuse the push.
      if [ -e "$shellcheck_tmp/external-sources" ]; then
        : > "$shellcheck_tmp/source-names" || exit 1
        # An argument is a double-quoted path, a single-quoted one, or a bare word whose
        # backslash escapes are kept and then undone, so a name with a space stays whole. The pattern travels as an argument: a single-quote
        # alternative cannot sit inside the single-quoted sh -c body.
        src_pat='(^|[;&|[:space:]])(\\.|source)[[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|([^[:space:];&|\\]|\\\\.)+)|source=("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+)'
        while :; do
          # Each step's status is its own: in a pipeline only the last one counts, and a failed
          # extraction would pass as a short list of names.
          ( cd "$tree" && find . -type f ! -name .shellcheckrc -exec sh -c 'pat=$1; shift; grep -h -o -E -e "$pat" -- "$@"; st=$?; [ "$st" -le 1 ]' sh "$src_pat" {} + ) > "$shellcheck_tmp/source-lines" \\
            && sed -E -e 's/^[;&|[:space:]]?(\\.|source)[[:space:]]+//' -e 's/^source=//' -e '/^["'"'"']/!s/\\\\(.)/\\1/g' -e 's/^"(.*)"$/\\1/' -e "s/^'(.*)'\\$/\\\\1/" -e 's|.*/||' "$shellcheck_tmp/source-lines" > "$shellcheck_tmp/source-args" || {
            echo "etymd: cannot read what the scripts of $short source" >&2
            exit 1
          }
          st=0
          grep -v -e '[$]' -e '^$' "$shellcheck_tmp/source-args" > "$shellcheck_tmp/source-kept" || st=$?
          [ "$st" -le 1 ] && sort -u "$shellcheck_tmp/source-kept" > "$shellcheck_tmp/source-names.next" || {
            echo "etymd: cannot read what the scripts of $short source" >&2
            exit 1
          }
          cmp -s "$shellcheck_tmp/source-names.next" "$shellcheck_tmp/source-names" && break
          mv "$shellcheck_tmp/source-names.next" "$shellcheck_tmp/source-names" \\
            && xargs -0 "$discover" --context "$shellcheck_tmp" "$tree" < "$shellcheck_tmp/entries" || {
            echo "etymd: cannot stage what the scripts of $short source" >&2
            exit 1
          }
        done
      fi
      count=$(wc -c < "$shellcheck_tmp/count") || exit 1
      zsh_count=$(wc -c < "$shellcheck_tmp/zsh-count") || exit 1
      other_count=$(wc -c < "$shellcheck_tmp/other-count") || exit 1
      skip_count=$(wc -c < "$shellcheck_tmp/skip-count") || exit 1
      # wc may pad its counts with leading blanks (POSIX permits), and an integer test on a
      # padded read is implementation-defined — a rejecting [ would turn every gate branch
      # false and silently skip the step. Each tally is folded through arithmetic once (it
      # accepts surrounding whitespace), so every consumer below sees a canonical integer.
      # Not tr in a pipeline: the pipeline would report tr's status and mask a failed wc.
      count=$((count))
      zsh_count=$((zsh_count))
      other_count=$((other_count))
      skip_count=$((skip_count))
      if [ "$skip_count" -gt 0 ]; then
        echo "› shellcheck: $((skip_count)) tracked path(s) that are symlinks or submodule entries — no script bytes of their own (a link's target is checked under its own path); not checked, not failed"
      fi
      if [ "$zsh_count" -gt 0 ]; then
        echo "› shellcheck: $((zsh_count)) zsh script(s) excluded — shellcheck cannot parse zsh (SC1071); not checked, not failed"
      fi
      if [ "$other_count" -gt 0 ]; then
        echo "› shellcheck: $((other_count)) script(s) under another interpreter (ksh, ash, …) — outside the sh dialects; not checked, not failed"
      fi
      if [ "$count" -eq 0 ]; then
        echo "› shellcheck: no shell script $where — nothing to check there"
      else
        echo "› shellcheck ($((count)) scripts $where, blocking at severity=warning)"
        # One run at the widest severity, gcc format (was two: a blocking pass, then the same
        # scripts again for advice). The error/warning lines in the one output ARE the blocking
        # verdict; every other line is the advice — one read of one run instead of two passes
        # over files already read.
        out=$( cd "$tree" && env SHELLCHECK_OPTS="$sc_kept" xargs -0 shellcheck -S style -f gcc -- < "$shellcheck_tmp/scripts" 2> "$shellcheck_tmp/err" )
        sc_rc=$?
        # The 2> redirect hangs off the checker command, so a failed cd leaves the err file
        # never created: the read is guarded, and an unread stderr is empty, never fatal.
        err=$(cat "$shellcheck_tmp/err" 2>/dev/null) || true
        # The verdict is read in three reads, each closed against a fold that used to pass
        # pushes: a broken grep (status 2 or more) read as "no findings"; a run that exited
        # nonzero while saying nothing (nothing was checked — a failed cd) read as clean; a
        # severity word the patterns do not know (a checker that renamed a level) shipped real
        # findings as advice. The reads below refuse on all three, and on output that stops
        # parsing as gcc lines at all — drift is doubt, and doubt blocks.
        # The blocking read takes the lines the bar sits at, ANCHORED to the start of the line:
        # the old unanchored pattern also matched a finding-shaped PATH — a script named
        # "p:12:3: warning:s.sh" put its own name over the bar and refused a push over advice.
        # The anchor's price: a colon-bearing path whose real warning no longer parses as a
        # header reads as advice. A tracked path carrying a colon is a rare, pathological
        # shape, and the doubt read below still refuses when output stops parsing — the
        # trade is taken with both sides written down.
        block_pat='^[^:]+:[0-9]+:[0-9]+: (warning|error): '
        # The doubt read accepts the severities the checker emits at advice level too (note,
        # style, info) and tolerates colons inside the path — its question is not "is this
        # blocking?" but "is this a finding line at all?". A severity word outside the set, or
        # a line that is not a gcc finding, is the checker drifting under the gate.
        head_pat='^.+:[0-9]+:[0-9]+: (error|warning|note|style|info): '
        # grep's own status, captured on its own line (the classifier's match/error rule):
        # "no match" (1) is a verdict — clean of blocking lines; a failure (2 or more) is the
        # READER failing, and \`|| true\` folded the two into one silence that passed pushes
        # whose verdict was never read.
        st=0
        blocking=$(printf '%s\\n' "$out" | grep -E "$block_pat") || st=$?
        if [ "$st" -ge 2 ]; then
          echo "etymd: could not read the shellcheck verdict (grep exited $st) — refusing the push rather than passing a verdict this gate did not read" >&2
          exit 1
        fi
        # Doubt, not clean: a run that exits nonzero while saying nothing on stdout, or while
        # saying something that is not a finding line, refuses. Advice-only runs (note/style/
        # info lines) parse fine and pass: the checker exits 1 for findings of ANY level, and
        # xargs folds that into 1 (BSD) or 123 (GNU) — the statuses of a run that said
        # something, never of a clean one (a clean run is 0, and a checked-nothing run —
        # a failed cd — has empty stdout AND nonzero status, which is doubt by definition).
        doubt=0
        if [ "$sc_rc" -ne 0 ]; then
          if [ -z "$out" ]; then
            doubt=1
          else
            st=0
            printf '%s\\n' "$out" | grep -qEv "$head_pat" || st=$?
            [ "$st" -ne 1 ] && doubt=1
          fi
        fi
        # stderr is a diagnosis printed UNDER a refusal, never the verdict itself: the checker
        # crashing writes its reason there, and a nonzero status is what makes that a refusal —
        # a checker that exits CLEAN while chattering on stderr (a warning it does not count as
        # a finding) does not stop a push its findings cleared, because stderr alone was never
        # the old gate's bar either.
        if [ -n "$blocking" ] || [ "$doubt" -eq 1 ] \\
          || { [ "$sc_rc" -ne 0 ] && { [ -n "$err" ] || { [ "$sc_rc" -ne 1 ] && [ "$sc_rc" -ne 123 ]; }; }; }; then
          if [ -n "$err" ]; then
            printf '%s\\n' "$err"
          fi
          if [ -n "$blocking" ]; then
            printf '%s\\n' "$blocking"
            echo "  fix, or justify inline with '# shellcheck disable=SCxxxx  # why'"
          else
            if [ -n "$out" ]; then
              printf '%s\\n' "$out"
            fi
            echo "  the checker exited $sc_rc with output this gate cannot read as findings — nothing was checked, or a severity/format this gate does not know; refusing rather than passing it as advice"
          fi
          exit 1
        fi
        if [ -n "$err" ]; then
          echo "  · the checker wrote to stderr but exited clean — diagnosis, not a verdict:"
          printf '%s\\n' "$err" | sed 's/^/    /'
        fi
        # Everything below the blocking bar, shown once the push is already cleared. Never affects
        # the exit code — advice that can fail a push is not advice. ERE on purpose: the '\\|'
        # alternation this replaced is a GNU-ism BSD grep reads literally, which reprinted the
        # blocking findings verbatim as "advice" on a BSD desk. The same anchored pattern as the
        # blocking read, complemented: a line over the bar is never also advice.
        advice=$(printf '%s\\n' "$out" | grep -Ev "$block_pat" || true)
        if [ -n "$advice" ]; then
          echo "  · style/info (not blocking):"
          printf '%s\\n' "$advice" | sed 's/^/    /'
        fi
      fi
      rm -rf "$tree" || {
        # The checks passed; only the removal failed. A bare nonzero exit here read as a gate
        # failure with no diagnosis — name the tree so the residue can be found and removed.
        echo "✗ shellcheck: could not remove the checked tree $tree — cleanup failed after the checks ran; refusing the push" >&2
        exit 1
      }
    done
    # The re-baseline stamp is written here, after every commit's checks passed: a refused or
    # interrupted push never reaches this line, so the next push re-runs the whole-tree read
    # rather than trusting a re-baseline that did not complete. And only when the loop above
    # read at least one commit: a push with nothing in range (a terminal run, deletes only, a
    # rollback) never consumed the whole-tree trigger, so stamping the new version there would
    # baseline a checker upgrade that no whole read ever followed.
    if [ -n "$shas" ]; then
      printf '%s\\n' "$checker_ver" > "$checker_stamp" 2>/dev/null || true
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
  // Emitted unconditionally: the audit step below runs through run_gate even in a repo with no
  // package steps (shell is its only checkable surface), so the helper always has a caller —
  // dead text was the right call only while no step ran scrubbed by default.
  const runner = SCRUBBED_RUNNER
  const body = steps.length
    ? steps.map((s) => `echo "› ${s}"\nrun_gate ${s} || exit 1`).join("\n")
    : shellStep
      ? // A repo whose executable surface is shell HAS a correctness command — it just is not in
        // package.json. Claiming "none detected" beside a step that is about to run would be the
        // tool contradicting itself.
        'echo "› no package scripts — shell is this repo\'s checkable surface"'
      : 'echo "etymd: no correctness commands detected — add format:check / typecheck / lint"'
  // The truth gate on the repo's own instructions, at the tier this repo chose. Skipped with a
  // note rather than failing where etymd is not installed — a gate that cannot run must say so
  // instead of silently passing.
  const failOn = gates?.failOn ?? "risk"
  const auditStep = `
# The truth gate reads the bytes BEING PUSHED: each pushed tip is materialised as a detached
# worktree of its own commit and audited there. The TIP only, unlike the shell gate above,
# which reads every commit in the range: what the audit judges — whether the instructions
# describe the repo — is a property of the state a reader checks out, and a lie that an
# intermediate commit introduced and a later one removed misleads no one at the tip. The cost
# is the reason it stops there: one materialised tree and one audit per commit would multiply
# the push by the range length. What the audit shares with the shell gate is the raw-blob
# rule: the worktree is added --no-checkout and populated entry by entry from git's object store (\`git cat-file blob\`, one process per file — the
# price of never converting). A checkout would run every tracked file's smudge filters and
# let an unrelated one's failure refuse the push, and \`git archive\` is no way out either:
# it honours export-ignore (a file so marked would leave the audit silently) and it runs
# working-tree conversion — a required filter kills it mid-stream, a non-required one hands
# the audit CONVERTED bytes — while its death inside a pipeline read as tar's status and the
# audit ran over an empty tree. Symlinks are re-linked, the exec bit is kept, submodule
# entries have no bytes of their own. --no-checkout leaves the worktree's index EMPTY, so the
# audit's git-scoped enumeration (ls-files) would list nothing while every file sits on disk —
# read-tree fills the index from the same commit directly: no checkout runs, no filter, the
# raw-blob rule holds. Installed binaries belong to the checkout, not the commit: the checkout's
# node_modules is linked into the audit tree (best effort — a committed node_modules path stays
# the commit's), because a tree without it degrades every command claim the audit cannot resolve
# to an installed binary into "unverifiable, skipped", and dead commands are exactly what this
# gate exists to catch. The link cuts the other way too: a binary installed in this checkout
# but absent from an older pushed tip's dependencies lets that tip's claim resolve — a narrow
# case (pushing a tip that is not the checkout's HEAD), known and accepted rather than paid for
# by skipping the link. hooksPath is neutralised for the materialisation
# itself so no hook of the pushed tree runs as a side effect of this read; the audit inside
# sees the repo's own config. The materialisation and the audit both run scrubbed (run_gate):
# a child git inheriting git's exported names ignores the worktree it stands in, so read-tree
# would write the pushing checkout's index while the audit tree's stayed empty. A push that carries no commits
# (deletes only) audits nothing, and says so. Every exit — a refused audit, a failed
# materialisation, a signal — deregisters the tip's worktree before its directory goes:
# removing only the directory left a registration pointing at nothing behind every failed
# push. Only this hook's own worktree is named, never a prune, which would also drop the
# registrations of the repo's other worktrees whose directories happen to be away.
if command -v etymd >/dev/null 2>&1; then
  (
    audit_tmp=$(mktemp -d) || exit 1
    wt=""
    trap '[ -z "$wt" ] || run_gate git -c core.hooksPath=/dev/null worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "$audit_tmp"' 0
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
    tab=$(printf '\\t')
    for tip in $tips; do
      wt=$(mktemp -d "$audit_tmp/tip.XXXXXX") || exit 1
      # Materialised through run_gate, like the audit itself: git exports GIT_DIR and friends
      # to this hook, and a child git that inherits them ignores its cwd — an unscrubbed
      # read-tree writes the pushing checkout's REAL index while the audit tree's stays
      # empty (the audit's enumeration then sees nothing), and an unscrubbed worktree add or
      # ls-tree acts on the exporting repo instead of this one. Git's own stderr is kept and
      # printed under the refusal: a stale lock or a disk condition is something an operator
      # can act on, a bare nonzero is not.
      if ! run_gate git -c core.hooksPath=/dev/null worktree add --detach --no-checkout -q "$wt" "$tip" 2> "$audit_tmp/materialise.err" \\
        || ! run_gate git -C "$wt" -c core.hooksPath=/dev/null read-tree "$tip" >> "$audit_tmp/materialise.err" 2>&1 \\
        || ! run_gate git ls-tree -r -z "$tip" > "$audit_tmp/audit-entries" 2>> "$audit_tmp/materialise.err"; then
        echo "✗ etymd audit: could not materialise $(git rev-parse --short "$tip" 2>/dev/null || echo "$tip") for the audit — refusing the push rather than certifying bytes this gate did not read; git's reason follows" >&2
        cat "$audit_tmp/materialise.err" >&2
        exit 1
      fi
      st=0
      xargs -0 sh -c 'wt=$1; tab=$2; shift 2
        # The same GIT_* scrub as the hook run_gate, inlined: this loop is its own shell, the
        # function is not in scope, and a cat-file inheriting git exported names would read
        # the exporting repo objects, not this tip.
        gate() { env $(env | grep -o "^GIT_[A-Za-z0-9_]*" | sed "s/^/-u /") "$@"; }
        # A record path must stay inside the worktree: the git writers themselves refuse a
        # tree entry whose name carries .., but a hand-forged or corrupted object reaches
        # ls-tree verbatim, and an escaping name writes outside the tree this gate just
        # built — refuse it like an unreadable entry: bytes this gate cannot safely place
        # are bytes it will not certify.
        for record do
          meta=\${record%%"$tab"*}
          file=\${record#*"$tab"}
          case $file in
            (""|/*|.|..|./*|../*|*/..|*/../*|*/.|*/./*)
              echo "etymd: tracked path does not stay inside the audited tree: $file" >&2
              exit 1 ;;
          esac
          case \${meta%% *} in (160000) continue ;; esac
          case $file in (*/*) dir=\${file%/*} ;; (*) dir=. ;; esac
          mkdir -p -- "$wt/$dir" || exit 1
          case \${meta%% *} in
            (120000) ln -s -- "$(gate git cat-file blob "\${meta##* }")" "$wt/$file" || exit 1 ;;
            (*)
              gate git cat-file blob "\${meta##* }" > "$wt/$file" || exit 1
              case \${meta%% *} in (100755) chmod +x "$wt/$file" || exit 1 ;; esac ;;
          esac
        done' sh "$wt" "$tab" < "$audit_tmp/audit-entries" || st=$?
      if [ "$st" -ne 0 ]; then
        echo "✗ etymd audit: could not materialise $(git rev-parse --short "$tip" 2>/dev/null || echo "$tip") for the audit — a tracked entry could not be written as its raw blob — refusing the push rather than certifying bytes this gate did not read" >&2
        exit 1
      fi
      # The checkout's installed binaries, linked in for the audit run (see the block
      # comment): any failure here only restores the skip-with-disclosure behaviour, never
      # blocks a push. The link is skipped when the tip tracks anything under node_modules/
      # itself: \`ln -s target dir\` with an EXISTING directory grafts the link INSIDE it
      # ($wt/node_modules/node_modules), handing the audit the checkout's live bytes under
      # the pushed tree's name — a committed node_modules path stays the commit's, exactly
      # as the block comment claims.
      checkout_root=$(git rev-parse --show-toplevel 2>/dev/null) \\
        && [ -d "$checkout_root/node_modules" ] \\
        && [ ! -e "$wt/node_modules" ] \\
        && ln -s "$checkout_root/node_modules" "$wt/node_modules" || :
      echo "› etymd audit --no-ledger --fail-on ${failOn} (at $(git rev-parse --short "$tip" 2>/dev/null || echo "$tip"), the pushed tip)"
      if ! (cd "$wt" && run_gate etymd audit --no-ledger --fail-on ${failOn}); then
        exit 1
      fi
      # The remove on the success path gets the shellcheck cleanup branch's own treatment:
      # the checks passed, and a cleanup that fails anyway refuses the push NAMING the tree
      # and the tip it audited, with git's stderr beside it — a bare nonzero exit after a
      # green audit is a refusal nobody can act on. Run scrubbed like the materialisation:
      # the trap's own remove (a silent best effort) hits the same hazard.
      if ! run_gate git -c core.hooksPath=/dev/null worktree remove --force "$wt" >/dev/null 2> "$audit_tmp/remove.err"; then
        echo "✗ etymd audit: could not remove the audited worktree $wt (tip $(git rev-parse --short "$tip" 2>/dev/null || echo "$tip")) — cleanup failed after the audit passed; refusing the push; git's reason follows" >&2
        cat "$audit_tmp/remove.err" >&2
        exit 1
      fi
      wt=""
    done
  ) || exit 1
else
  echo "› etymd audit skipped (not on PATH)"
fi`
  return stampGenerated(`#!/usr/bin/env sh
# etymd: correctness gate. Mirrors CI cheapest-first; blocks the push on any failure.

${prePushContentGatePreflight(selfBuild)}

${localHookCall("pre-push", true)}${runner}
${body}${shellStep}
${auditStep}

# Content screen, second pass — the WHOLE TREE rather than one diff. Catches anything committed
# with --no-verify and anything a rebase or merge brought in from elsewhere. Advisory here: its
# findings never block the push — the blocking decision belongs at commit time, where the fix
# is cheap. The checker was resolved, and a broken override refused, at the top of this hook.
if [ -x "$GATE" ]; then
${contentScreenCall({
  args: "--tree --advisory",
  envVar: "CONTENT_GATE",
  blocking: false,
  indent: "  ",
})}
fi

exit 0
`)
}

/**
 * The publish gate: the only check that inspects what actually SHIPS.
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
