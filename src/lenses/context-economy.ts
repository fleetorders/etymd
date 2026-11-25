import { CONFIG_FILE, DEFAULT_CONFIG } from "../core/config.js"
import { contextFileLabel, measureContext } from "../core/context.js"
import type { ContextFootprintFacts } from "../core/types.js"
import type { Finding, Lens, LensReport } from "../engine/finding.js"

const LENS_ID = "context-economy"

/** Default total always-loaded words past which the footprint itself becomes a finding. */
export const TOTAL_BUDGET_WORDS = DEFAULT_CONFIG.context.totalWords

/**
 * The footprint's standing against the committed baseline, as one disclosure line
 * (docs/decisions.md, D-016). The budget stays the gate; this makes growth visible even while
 * under it, which a static threshold cannot — a footprint can double inside budget and the
 * budget says nothing.
 */
function footprintDriftDisclosure(
  from: ContextFootprintFacts,
  to: { totalWords: number; files: number },
): string {
  const dw = to.totalWords - from.totalWords
  const pct = from.totalWords > 0 ? Math.round((dw / from.totalWords) * 100) : null
  const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`)
  // Words can stay flat while files split or merge — that is still a move on the axis.
  const moved = dw !== 0 || to.files !== from.files
  const delta = moved
    ? ` (${signed(dw)}w${pct === null ? "" : `, ${signed(pct)}%`})`
    : " (unchanged)"
  return `Always-loaded footprint vs the approved baseline: ${from.totalWords}w → ${to.totalWords}w${delta}.`
}

/**
 * Economy lens: the always-loaded instruction footprint, as findings. Context is the dominant
 * cost of the agent loop, and attention dilutes long before windows fill — a lean contract is
 * a correctness feature, not a style preference.
 */
export const contextEconomyLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Context economy",
  kind: "improvement",
  async run(ctx): Promise<LensReport> {
    const budgets = ctx.config?.config.context ?? DEFAULT_CONFIG.context
    const budget = await measureContext(ctx.root, budgets.perFileWords)
    const findings: Finding[] = []
    const aliased = budget.files.filter((f) => f.aliases?.length)

    for (const f of budget.extractionCandidates) {
      // The label may name several aliases; the ID stays the primary path alone, because a
      // ledger entry keyed on it has to survive a repo adding or dropping one of the names.
      const label = contextFileLabel(f)
      findings.push({
        id: `${LENS_ID}/heavy-file:${f.path}`,
        lens: LENS_ID,
        tier: "gap",
        claim: `${label} loads ${f.words} words (~${f.approxTokens} tokens) into every session`,
        evidence: [`${label}: ${f.words} words`],
        why: "Reference material that loads every session taxes attention and cost on tasks that never need it.",
        action: "Extract the reference bulk into an on-demand skill/doc and keep a pointer.",
        effort: "M",
        confidence: "high",
      })
    }

    if (budget.totalWords >= budgets.totalWords) {
      findings.push({
        id: `${LENS_ID}/total-over-budget`,
        lens: LENS_ID,
        tier: "gap",
        claim: `The always-loaded footprint is ${budget.totalWords} words (~${budget.totalApproxTokens} tokens) — over the ${budgets.totalWords}-word budget`,
        evidence: budget.files.slice(0, 5).map((f) => `${contextFileLabel(f)}: ${f.words}w`),
        why: "Every session pays this before the task begins; instruction-following degrades as the resident context grows.",
        action: "Run `etymd context` for the per-file breakdown and extract the heaviest block.",
        effort: "M",
        confidence: "high",
      })
    }

    return {
      lens: LENS_ID,
      version: "1",
      title: "Context economy",
      kind: "improvement",
      status: "ran",
      disclosures: [
        ...(ctx.config?.problems ?? []),
        ...aliased.map(
          (f) =>
            `${contextFileLabel(f)} are one file (same inode) — counted once, at ${f.words} words.`,
        ),
        // No committed baseline at all is the instruction-truth lens's line to say; a baseline
        // that predates the footprint fact is this lens's, because only here does the absence
        // hide an economy number rather than a truth drift.
        ...(ctx.baseline?.facts.context
          ? [
              footprintDriftDisclosure(ctx.baseline.facts.context, {
                totalWords: budget.totalWords,
                files: budget.files.length,
              }),
            ]
          : ctx.baseline
            ? [
                "The approved baseline predates footprint measurement — footprint drift is not measurable until the next `etymd approve`.",
              ]
            : []),
        `Budgets: ${budgets.perFileWords} words/file, ${budgets.totalWords} words total (${
          budgets.perFileWords === DEFAULT_CONFIG.context.perFileWords &&
          budgets.totalWords === DEFAULT_CONFIG.context.totalWords
            ? `defaults — override under \`context\` in ${CONFIG_FILE}`
            : `set in ${CONFIG_FILE}`
        }). Scoped Cursor rules excluded.`,
      ],
      findings,
    }
  },
}
