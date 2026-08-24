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
 * for (guarded-side names, hostnames, identities), so they can never live in a tracked file — the
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
function localHookCall(hook: string): string {
  return `# Repo-owned checks. This file is generated and will be overwritten; \`.githooks/${hook}.local\`
# is yours — etymd never reads, writes, or regenerates it. Put project-specific guards there.
LOCAL="$(dirname "$0")/${hook}.local"
if [ -x "$LOCAL" ]; then
  "$LOCAL" "$@" || exit 1
fi`
}

export function generatePreCommitHook(selfBuild = false): string {
  return stampGenerated(`#!/usr/bin/env sh
# etymd: process gate. Cheap, locally-knowable checks belong here (fast, blocks the commit).

${localHookCall("pre-commit")}

# Content screen — staged file bytes. Refuses to commit environment, guarded-side or identity
# detail into a repo whose history is (or could become) public. The checker and its patterns
# are machine-local by design, so this is a NO-OP wherever no checker is installed: safe to
# commit anywhere, active only where you opted in.
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
 * Three properties, each a lesson from a gate that failed:
 *
 * Scripts are re-discovered HERE, at push time, by shebang over tracked files — never baked in as
 * a list. A generated list is correct on the day it is written and wrong the first time someone
 * adds a script, and the failure is silent: the new file is simply never checked.
 *
 * A missing `shellcheck` is a LOUD skip naming the install command. A check that goes quiet when
 * its binary is absent is the worst kind — the repo looks guarded on every machine, and is
 * guarded on one.
 *
 * The blocking bar is `warning`; style and info print as advice AFTER the blocking pass. A gate
 * with a high false-positive rate does not make a repo careful, it teaches everyone the bypass
 * flag — and the flag is shared with the gates that must never be bypassed. Discarding the
 * sub-warning findings instead of showing them would be the opposite mistake: the cheap ones are
 * how a script gets better between defects, and they cost one extra pass over files already read.
 */
function shellcheckStep(): string {
  return `
# Shell correctness. Scripts are discovered by shebang over TRACKED files at push time, so a
# script added later is covered without regenerating this hook.
if command -v shellcheck >/dev/null 2>&1; then
  scripts=$(git ls-files -z \\
    | xargs -0 -I{} sh -c 'head -1 "{}" 2>/dev/null | grep -qE "^#!.*[/ ](ba|da|z)?sh( |$)" && echo "{}"' \\
    | sort)
  if [ -n "$scripts" ]; then
    echo "› shellcheck ($(printf '%s\\n' "$scripts" | wc -l | tr -d ' ') scripts, blocking at severity=warning)"
    printf '%s\\n' "$scripts" | xargs shellcheck -S warning || {
      echo "  fix, or justify inline with '# shellcheck disable=SCxxxx  # why'"
      exit 1
    }
    # Everything below the blocking bar, shown once the push is already cleared. Never affects
    # the exit code — advice that can fail a push is not advice.
    advice=$(printf '%s\\n' "$scripts" | xargs shellcheck -S style -f gcc 2>/dev/null \\
      | grep -v ': warning:\\|: error:' || true)
    if [ -n "$advice" ]; then
      echo "  · style/info (not blocking):"
      printf '%s\\n' "$advice" | sed 's/^/    /'
    fi
  fi
else
  echo "› shellcheck skipped (not on PATH) — install it to gate this repo's shell scripts"
fi`
}

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
  const body = steps.length
    ? steps.map((s) => `echo "› ${s}"\n${s} || exit 1`).join("\n")
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
if command -v etymd >/dev/null 2>&1; then
  echo "› etymd audit --fail-on ${failOn}"
  etymd audit --no-ledger --fail-on ${failOn} || exit 1
else
  echo "› etymd audit skipped (not on PATH)"
fi`
  return stampGenerated(`#!/usr/bin/env sh
# etymd: correctness gate. Mirrors CI cheapest-first; blocks the push on any failure.

${localHookCall("pre-push")}
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
