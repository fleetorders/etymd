import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import type { ProjectFacts } from "../../core/types.js"
import { pathExists, readText } from "../../core/util.js"

const pExecFile = promisify(execFile)

/**
 * Where the content screen's runner came from — the same order the generated hook resolves in.
 * Reported so a finding can name the arm that produced the runner, not just the runner.
 */
export type ScreenerSource = "CONTENT_GATE" | "dev-build" | "path"

export interface ScreenerProbe {
  /** A hook in this repo actually calls the content screen. Nothing below matters otherwise. */
  present: boolean
  /** Hooks that call it, for evidence. */
  doors: string[]
  /** The resolved runner, or null when nothing resolves (the designed no-op). */
  runner: string | null
  source: ScreenerSource | null
  /**
   * Did the runner answer `screen`? Null when there was nothing to ask — no runner resolved, or
   * the probe itself could not be carried out. Never guessed: a lens that reports "your gate is
   * broken" on an unperformed check is the failure this tool exists to catch.
   */
  answersScreen: boolean | null
  /** Why `answersScreen` is null, when it is — surfaced as a disclosure, never swallowed. */
  skipped?: string
}

const HOOK_FILES = ["pre-commit", "pre-push", "commit-msg"] as const

/** The call the pack emits at every screen door. Matching the CALL, not the resolution line. */
const SCREEN_CALL_RE = /"\$GATE"\s+screen\b/

/** The dev-build arm, emitted only into the screener's own repo. */
const DEV_BUILD_ARM = "[ -x ./dist/cli.js ]"

/**
 * Resolve the content screener exactly as the generated hook would, then ask it whether it
 * understands `screen`.
 *
 * Why this executes something during an audit, when nothing else here does: the question is
 * "will the gate run?", and no amount of reading answers it. The hook picks a runner at commit
 * time and calls it; if that runner is the wrong program, or an etymd too old to have `screen`,
 * the commit door fails closed with the runner's own unexplained error and the push door — which
 * ignores the screen's exit status by design — skips its pass in silence. That combination went
 * unnoticed across several repos for months, which is exactly the kind of quiet, unverified
 * claim this tool exists to refuse.
 *
 * Bounded deliberately: `screen --help` only, no repository arguments, a short timeout, output
 * discarded. It runs the same program the hook already runs on every commit, so it grants the
 * audit no reach the repo's own gate did not already have.
 */
export async function probeScreener(root: string, facts: ProjectFacts): Promise<ScreenerProbe> {
  const absent: ScreenerProbe = {
    present: false,
    doors: [],
    runner: null,
    source: null,
    answersScreen: null,
  }

  const dir = facts.hooks.dir
  if (!dir) return absent

  const doors: string[] = []
  let devBuildArm = false
  for (const name of HOOK_FILES) {
    const text = await readText(path.join(root, dir, name))
    if (!text || !SCREEN_CALL_RE.test(text)) continue
    doors.push(`${dir}/${name}`)
    if (text.includes(DEV_BUILD_ARM)) devBuildArm = true
  }
  if (!doors.length) return absent

  // The hook's own order: an explicit override, then the dev-build arm where the hook carries
  // one, then whatever is on PATH.
  let runner: string | null = null
  let source: ScreenerSource | null = null
  const override = process.env.CONTENT_GATE
  if (override) {
    runner = override
    source = "CONTENT_GATE"
  } else if (devBuildArm && (await pathExists(path.join(root, "dist", "cli.js")))) {
    runner = path.join(root, "dist", "cli.js")
    source = "dev-build"
  } else {
    runner = "etymd"
    source = "path"
  }

  try {
    // `screen --help` exits non-zero on a runner that does not know the subcommand; commander
    // prints its "unknown command" to stderr and fails. That failure IS the signal.
    await pExecFile(runner, ["screen", "--help"], { cwd: root, timeout: 10_000 })
    return { present: true, doors, runner, source, answersScreen: true }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean }
    // Nothing installed is the designed no-op, not a defect: the hook guards on `[ -x "$GATE" ]`
    // and skips itself where no checker exists. Say so, and claim nothing.
    if (e.code === "ENOENT") {
      return {
        present: true,
        doors,
        runner: null,
        source,
        answersScreen: null,
        skipped: `no checker named \`${runner}\` is installed — the screen doors no-op here by design, and nothing was verified.`,
      }
    }
    if (e.killed || e.code === "ETIMEDOUT") {
      return {
        present: true,
        doors,
        runner,
        source,
        answersScreen: null,
        skipped: `\`${runner} screen --help\` did not return within 10s — the runner was not verified either way.`,
      }
    }
    return { present: true, doors, runner, source, answersScreen: false }
  }
}
