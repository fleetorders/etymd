import path from "node:path"

import {
  fileOrigin,
  generateAgentsMd,
  generateArtifactCheckScript,
  generateCommitMsgHook,
  generatePreCommitHook,
  generatePrePushHook,
  isSafeGateCommand,
} from "../pack/templates.js"
import { DEFAULT_CONFIG, type GateConfig } from "./config.js"
import type { ProjectFacts } from "./types.js"
import { pathExists, readText } from "./util.js"

/**
 * The scan's opening guess at what a pre-push gate should run.
 *
 * `test` is included only when the existing hook already ran it. It stays out of the default set
 * — a slow suite in a push gate is how people learn to reach for `--no-verify` — but REMOVING a
 * check a repo already had is a silent downgrade, and a generator that quietly drops working
 * checks cannot be trusted to regenerate anything.
 */
export function derivedCommands(facts: ProjectFacts, existingHook?: string): string[] {
  const c = facts.commands
  const base = [c.formatCheck, c.typecheck, c.lint].filter(
    (k): k is string => Boolean(k) && isSafeGateCommand(c.raw[k as string]),
  )
  if (c.test && existingHook && new RegExp(`\\b${c.test}\\b`).test(existingHook)) {
    base.push(c.test)
  }
  return base
}

/**
 * Which risk-tier audit findings could ever fire in this repo, and why.
 *
 * The generated pre-push hook runs `etymd audit --fail-on <tier>`, and `risk` is the default. In a
 * repo where no risk-tier rule has its preconditions — no package manifest, no state doc — that
 * line is a gate that cannot fail: it exits 0 on every push and reads as assurance. Reporting a
 * check that cannot run is the exact failure this tool exists to catch, so the tier is derived and
 * the derivation is stated rather than assumed.
 *
 * Conservative by construction: a rule whose preconditions are uncertain counts as REACHABLE. A
 * wrongly-quiet gate is the failure being fixed; wrongly claiming a gate works is the same failure
 * wearing the other face, and only one of the two can be recovered from by reading the output.
 *
 * `gate-integrity/hooks-not-wired` is deliberately excluded: it fires when `core.hooksPath` is
 * unset, and the hook cannot execute in that state — inside the gate it is unreachable by
 * construction, whatever the repo looks like.
 */
export function riskReachability(facts: ProjectFacts): string[] {
  const reasons: string[] = []
  // instruction-truth: a script claim that no longer resolves, and a baseline command that
  // vanished. Both need a manifest to name scripts against; without one there is nothing to
  // contradict, and script claims are disclosed as unverifiable rather than flagged.
  // `publishRoute` is the scan's record of whether a root package.json was read at all
  // ("none" means there was none) — the manifest-presence fact, without a second one for it.
  if (facts.publishRoute !== "none") {
    reasons.push("an instruction file can name a package script that no longer exists")
  }
  // state-freshness: past 3x the staleness threshold with commits still landing, `gap` escalates.
  if (facts.artifacts.some((a) => a.kind === "state" && a.exists)) {
    reasons.push("a state doc can fall far enough behind the repo to escalate")
  }
  return reasons
}

/**
 * The tier the pre-push audit should fail on, and where that tier came from.
 *
 * A recorded `gates.failOn` is a decision and is never adjusted — the derivation may only choose
 * between defaults. That asymmetry is the point: the reverting regeneration this fixes was a
 * generated file quietly reinstating a default over a tier the repo had measured and chosen.
 */
export function deriveFailOn(
  facts: ProjectFacts,
  recorded: { failOn: string; explicit: boolean },
): { failOn: string; source: "config" | "derived" | "default"; reachable: string[] } {
  const reachable = riskReachability(facts)
  if (recorded.explicit) return { failOn: recorded.failOn, source: "config", reachable }
  if (recorded.failOn === "risk" && reachable.length === 0) {
    // Nothing can fail at `risk` here, so `risk` would be a gate that always passes. `gap` is the
    // next tier down that this repo can actually reach — a narrower promise that is true.
    return { failOn: "gap", source: "derived", reachable }
  }
  return { failOn: recorded.failOn, source: "default", reachable }
}

export interface GeneratedFile {
  path: string
  contents: string
  /** Present on disk already — apply will skip or ask before overwriting. */
  exists: boolean
  /** The existing file's content differs from what the pack would generate. */
  differs?: boolean
  /**
   * WHY it differs, when it does — the two cases pull in opposite directions and must not share
   * a bucket. `stale` is provably etymd's own output against inputs that have since moved (an
   * older pack, a renamed script, a changed package manager): regenerating it destroys nothing.
   * `edited` and `unstamped` may hold someone's work, so they are kept.
   */
  drift?: "stale" | "edited" | "unstamped"
  /** Hooks need the executable bit. */
  executable?: boolean
  label: string
}

export interface PlanOptions {
  /** Scaffold a minimal AGENTS.md (init only offers this when none exists). */
  agents: boolean
  gates: boolean
  /**
   * Emit the publish-time screen. Defaults to `facts.publishable` — set it explicitly to
   * override the derivation (a repo that publishes by a route npm cannot see, or one that
   * declines the door).
   */
  publishGate?: boolean
  /** Recorded gate choices; absent means derive everything from the scan. */
  gateConfig?: GateConfig
}

/** Build the file set an onboarding would write, flagging which exist and which differ. */
export async function planWorkflow(
  root: string,
  facts: ProjectFacts,
  opts: PlanOptions,
): Promise<GeneratedFile[]> {
  const out: GeneratedFile[] = []
  const add = async (rel: string, contents: string, label: string, executable = false) => {
    const abs = path.join(root, rel)
    const exists = await pathExists(abs)
    const existing = exists ? await readText(abs) : null
    const differs = exists ? existing !== contents : undefined
    // The stamp answers "is this still exactly what we wrote?", which is the only question that
    // makes overwriting safe. Everything else — including an unstamped file we may well have
    // written under an older version — stays in the keep-it bucket.
    const origin = differs && existing !== null ? fileOrigin(existing) : undefined
    out.push({
      path: rel,
      contents,
      exists,
      differs,
      drift: origin === "pack" ? "stale" : origin,
      executable,
      label,
    })
  }

  if (opts.agents) {
    await add("AGENTS.md", generateAgentsMd(facts), "Minimal operating contract (scaffold)")
  }
  if (opts.gates) {
    // Preservation belongs HERE, not in the command that calls this. `etymd gates` used to read
    // the existing hook itself, so every other caller — the fleet drift check above all —
    // regenerated without it and compared a repo against a hook missing checks the repo really
    // runs: permanent false drift, and a silent downgrade for anyone who applied it.
    const existingPrePush = await readText(path.join(root, ".githooks", "pre-push"))

    await add(".githooks/pre-commit", generatePreCommitHook(), "Process gate (pre-commit)", true)
    // The recorded config, not the derived one below: the derivation exists to fill in commands
    // this hook does not run, and the format check must resolve identically here and in the
    // fleet's drift comparison — a key read in one place and not the other reads as drift.
    await add(
      ".githooks/commit-msg",
      generateCommitMsgHook(opts.gateConfig),
      "Message gate (content screen, format)",
      true,
    )
    // A recorded command set is the user's decision and wins outright; otherwise derive, keeping
    // whatever the existing hook already ran.
    // `?.commands?.length`, not `?.commands.length`: a hand-written config legitimately sets only
    // `failOn`, and the type says `commands` is required while real input often omits it. A
    // config the user wrote by hand must never crash the generator.
    const gateConfig: GateConfig | undefined = opts.gateConfig?.commands?.length
      ? opts.gateConfig
      : {
          commands: derivedCommands(facts, existingPrePush ?? undefined),
          failOn: opts.gateConfig?.failOn ?? DEFAULT_CONFIG.gates.failOn,
          publishGate: opts.gateConfig?.publishGate,
          commitFormat: opts.gateConfig?.commitFormat,
          allowWriting: opts.gateConfig?.allowWriting ?? [],
        }

    await add(
      ".githooks/pre-push",
      generatePrePushHook(facts, gateConfig),
      "Correctness gate (pre-push)",
      true,
    )
    // The publish door is only meaningful where something actually ships. A recorded answer
    // wins; otherwise fall back to the derivation. Note the derivation is a GUESS: npm treats a
    // missing `private` as publishable, which is right about npm's semantics and wrong about a
    // local fork that will never be published — hence the recorded override.
    if (opts.gateConfig?.publishGate ?? opts.publishGate ?? facts.publishable) {
      await add(
        "scripts/artifact-check.sh",
        generateArtifactCheckScript(),
        "Content screen (published artifact)",
        true,
      )
    }
  }

  return out
}
