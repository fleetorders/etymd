import { promises as fs } from "node:fs"
import path from "node:path"

import { meetsFailOn, parseFailOnTier } from "../engine/finding.js"
import { runAudit } from "../engine/run.js"
import { normaliseDecisionOrder } from "../lenses/state-freshness.js"
import {
  print,
  renderFindings,
  renderLedgerDiff,
  renderLensCoverage,
  section,
} from "../ui/render.js"
import { theme } from "../ui/theme.js"

export interface AuditOptions {
  cwd: string
  json?: boolean
  /** Truth lenses only — the doctor subset ("is this still true?"). */
  truth?: boolean
  /** Restrict to one lens id. */
  lens?: string
  /** Do not persist the reconciled ledger (read-only report). */
  noLedger?: boolean
  /** Exit non-zero when a finding at (or above) this tier exists — the CI gate. */
  failOn?: string
  /** This fork's upstream remote name — see `AuditOptions.upstreamRemote` in the engine. */
  upstream?: string
  /** Apply the mechanical fixes the tool owns (decision blocks into id order) before the
   * report — the audit re-runs on the fixed files, so what it prints is what remains. */
  fix?: boolean
}

/** The one finding class `--fix` owns: whole-block id ordering of a decisions file. The file
 * path rides inside the finding id (`state-freshness/id-order:<file>:<entry>`); repo-relative
 * paths ending in `:D-NNN` split unambiguously off the anchored ends. */
const ID_ORDER_ID = /^state-freshness\/id-order:(.+):D-\d+$/

async function applyMechanicalFixes(
  cwd: string,
  narrow: { kind?: "truth"; lensIds?: string[]; upstreamRemote?: string },
): Promise<string[]> {
  // Read-only pre-pass, narrowed exactly like the report below it: the fix must not feed the
  // ledger findings that the very fix removes — the report is produced by a fresh scan of
  // the fixed files, not by muting findings.
  const pre = await runAudit(cwd, { ...narrow, persistLedger: false })
  const files = new Set(
    pre.findings
      .map((f) => ID_ORDER_ID.exec(f.id)?.[1])
      .filter((f): f is string => f !== undefined),
  )
  const notes: string[] = []
  for (const file of files) {
    const abs = path.join(cwd, file)
    let text: string
    try {
      text = await fs.readFile(abs, "utf8")
    } catch {
      notes.push(`  ? ${file} could not be read — left alone`)
      continue
    }
    const res = normaliseDecisionOrder(text)
    if (res.kind === "fixed") {
      await fs.writeFile(abs, res.text, "utf8")
      const moves = res.moves.map((m) => `${m.id} (position ${m.from} → ${m.to})`).join(", ")
      notes.push(`  ● fixed ${file}: moved ${moves}`)
    } else if (res.kind === "refused") {
      notes.push(`  ? ${file} not reordered — ${res.reason}`)
    }
    // clean cannot happen: the finding says the order is wrong; if the normaliser
    // disagrees anyway, silence is the honest report — the finding stands for a human.
  }
  return notes
}

export async function run(opts: AuditOptions): Promise<void> {
  // Validate the gate tier BEFORE the audit runs — a typo must never report success.
  const failOn = opts.failOn === undefined ? undefined : parseFailOnTier(opts.failOn)
  if (opts.fix) {
    const notes = await applyMechanicalFixes(opts.cwd, {
      kind: opts.truth ? "truth" : undefined,
      lensIds: opts.lens ? [opts.lens] : undefined,
      upstreamRemote: opts.upstream,
    })
    if (notes.length && !opts.json) {
      section("Fixes applied")
      for (const n of notes) print(n)
    }
    // JSON mode's stdout is a stable schema: the moves go to stderr, where a pipeline
    // reading stdout never sees them, and the JSON itself reports the post-fix state.
    if (opts.json) for (const n of notes) process.stderr.write(`${n.trimStart()}\n`)
  }
  const result = await runAudit(opts.cwd, {
    kind: opts.truth ? "truth" : undefined,
    lensIds: opts.lens ? [opts.lens] : undefined,
    persistLedger: !opts.noLedger,
    upstreamRemote: opts.upstream,
  })

  if (failOn && meetsFailOn(result.findings, failOn)) {
    process.exitCode = 1
  }

  if (opts.json) {
    print(
      JSON.stringify(
        {
          profile: result.profile,
          baseline: result.baseline
            ? { packVersion: result.baseline.packVersion, approvedAt: result.baseline.approvedAt }
            : null,
          reports: result.reports.map(({ findings: _findings, ...r }) => r),
          findings: result.findings,
          diff: {
            new: result.diff.new.map((f) => f.id),
            stillOpen: result.diff.stillOpen.map((f) => f.id),
            regressed: result.diff.regressed.map((f) => f.id),
            resolved: result.diff.resolved.map((e) => e.id),
            dismissed: result.diff.dismissed.map((f) => f.id),
            accepted: result.diff.accepted.map((f) => f.id),
          },
        },
        null,
        2,
      ),
    )
    return
  }

  section(
    `${opts.truth ? "Doctor — is this still true?" : "Audit"} ${theme.dim(`· ${result.facts.name} · ${result.profile} profile`)}`,
  )
  if (!result.baseline && !opts.truth) {
    print(
      `  ${theme.dim("no committed baseline — run `etymd init` to approve one; drift checks are limited")}`,
    )
  }

  renderLensCoverage(result.reports)

  section(`Findings ${theme.dim("(ranked: risk → gap → polish, cheapest first)")}`)
  renderFindings(result.findings)
  renderLedgerDiff(result.diff)

  const top = result.findings[0]
  if (top) {
    print()
    print(
      `  ${theme.dim("next:")} ${theme.heading(top.claim)}${top.action ? theme.dim(` — ${top.action}`) : ""}`,
    )
  }
}
