import type { Confidence, Effort, Finding, FindingTier } from "./finding.js"
import type { FleetProjectSweep } from "./fleet.js"

/**
 * `etymd propose` — the scoring step between the sweep and a filed proposal.
 *
 * The sweep already mints everything a proposal needs (every finding carries an action, an
 * effort and a confidence; `recurringClasses` names the classes open in ≥2 projects). This
 * module adds the two things that were missing: a rubric the FLEET authors (the tool ships
 * none — with no rubric there is nothing to run) and a stable record shape (`proposal/1`)
 * a planning surface can file mechanically.
 *
 * Everything here is a pure function of its inputs — no clocks, no randomness — so the same
 * sweep plus the same rubric yields byte-identical output, and a filed proposal can be
 * re-derived and compared later. Decision record: docs/decisions/012.
 */

/** The record schema marker — experimental through 0.2.x with the rest of the fleet family. */
export const PROPOSAL_SCHEMA = "proposal/1"

/**
 * The criteria the tool can compute, each mapped to a 1–3 value. The vocabulary is closed: a
 * rubric line naming anything else is refused, because a criterion this tool cannot derive
 * mechanically would be an opinion wearing a number — the exact product anti-pattern. The
 * WEIGHTS are the fleet's; the tool imposes none.
 */
export const RUBRIC_CRITERIA = ["severity", "economy", "confidence", "breadth"] as const
export type RubricCriterion = (typeof RUBRIC_CRITERIA)[number]

export interface RubricLine {
  criterion: RubricCriterion
  weight: number
}

export interface Rubric {
  lines: RubricLine[]
}

/**
 * Parse a rubric file: labeled lines, one criterion per line (`criterion: <weight>`), `#`
 * comments and blanks ignored. The line is the unit of refusal — unknown criterion, malformed
 * line, duplicate criterion, or a rubric with no criteria at all each name their line (or the
 * file), never a silent skip and never a default weight.
 */
export function parseRubric(text: string, file: string): Rubric {
  const lines: RubricLine[] = []
  const seen = new Map<RubricCriterion, number>()
  const rows = text.split(/\r?\n/)
  for (const [i, raw] of rows.entries()) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const at = i + 1
    const refuse = (why: string): Error =>
      new Error(
        `${file}:${at} \`${raw.trim()}\` — ${why} (criteria: ${RUBRIC_CRITERIA.join(", ")})`,
      )
    const sep = line.indexOf(":")
    if (sep < 0) throw refuse("expected `criterion: <weight>`")
    const criterion = line.slice(0, sep).trim()
    const weightRaw = line.slice(sep + 1).trim()
    if (!(RUBRIC_CRITERIA as readonly string[]).includes(criterion)) {
      throw refuse(`unknown criterion \`${criterion}\``)
    }
    if (!/^\d+$/.test(weightRaw) || Number(weightRaw) < 1) {
      throw refuse(`weight \`${weightRaw}\` is not a positive integer`)
    }
    const known = criterion as RubricCriterion
    if (seen.has(known)) {
      throw new Error(
        `${file}:${at} \`${raw.trim()}\` — criterion \`${criterion}\` is already weighted on line ${seen.get(known)}; one line per criterion`,
      )
    }
    seen.set(known, at)
    lines.push({ criterion: known, weight: Number(weightRaw) })
  }
  if (!lines.length) {
    throw new Error(`${file} carries no criterion lines — a rubric with no criteria scores nothing`)
  }
  return { lines }
}

const TIER_VALUE: Record<FindingTier, number> = { risk: 3, gap: 2, polish: 1 }
const EFFORT_VALUE: Record<Effort, number> = { S: 3, M: 2, L: 1 }
const CONFIDENCE_VALUE: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }

/** The proposal subject, family-agnostic: one finding, or one recurring class. */
interface Subject {
  id: string
  kind: "finding" | "class"
  classId: string
  tier: FindingTier
  effort: Effort
  confidence: Confidence
  /** Personal projects carrying the subject — the class's real breadth; a finding's is 1. */
  projects: string[]
  action: string
  /** The member findings' evidence — the implications block is computed from it. */
  evidence: string[]
}

function findingSubject(project: FleetProjectSweep, f: Finding): Subject {
  return {
    id: `${project.name}:${f.id}`,
    kind: "finding",
    classId: f.id.split(":")[0] ?? f.id,
    tier: f.tier,
    effort: f.effort,
    confidence: f.confidence,
    projects: [project.name],
    action: f.action ?? "",
    evidence: f.evidence,
  }
}

function classSubject(
  classId: string,
  members: { project: FleetProjectSweep; finding: Finding }[],
): Subject {
  // Conservative aggregation — worst tier, most expensive effort, weakest confidence — because
  // a proposal must not overstate an opportunity to win rank. Note the directions differ: the
  // worst tier is the most severe (max TIER_VALUE), while the worst effort and the weakest
  // confidence are the smallest values.
  const pick = <T extends string>(
    order: Record<T, number>,
    at: (f: Finding) => T,
    dir: 1 | -1,
  ): T => {
    const values = members.map((m) => order[at(m.finding)])
    const value = dir === 1 ? Math.max(...values) : Math.min(...values)
    return (Object.entries(order) as [T, number][]).find(([, v]) => v === value)![0]
  }
  const actions = [...new Set(members.map((m) => m.finding.action).filter(Boolean))].sort()
  return {
    id: `class:${classId}`,
    kind: "class",
    classId,
    tier: pick(TIER_VALUE, (f) => f.tier, 1),
    effort: pick(EFFORT_VALUE, (f) => f.effort, -1),
    confidence: pick(CONFIDENCE_VALUE, (f) => f.confidence, -1),
    projects: [...new Set(members.map((m) => m.project.name))].sort(),
    action: actions.join("; "),
    evidence: members.flatMap((m) => m.finding.evidence),
  }
}

export interface MatchedLine {
  criterion: RubricCriterion
  weight: number
  /** The computed 1–3 value — carried beside the weight so the score is auditable. */
  value: number
}

export interface Implications {
  projects: string[]
  files: string[]
  gates: string[]
  reversibility: "regenerable" | "git-reversible" | "undetermined"
}

export interface Proposal {
  id: string
  schema: typeof PROPOSAL_SCHEMA
  class: string
  kind: "finding" | "class"
  projects: string[]
  action: string
  effort: Effort
  confidence: Confidence
  score: number
  matched: MatchedLine[]
  implications: Implications
}

const CRITERION_VALUE: Record<RubricCriterion, (s: Subject) => number> = {
  severity: (s) => TIER_VALUE[s.tier],
  economy: (s) => EFFORT_VALUE[s.effort],
  confidence: (s) => CONFIDENCE_VALUE[s.confidence],
  breadth: (s) => Math.min(3, s.projects.length),
}

// A path-shaped token: the run up to the first whitespace or `:`, kept when it contains `/`
// (`.githooks/`, `.github/workflows/ci.yml`) or looks like `name.ext` (`AGENTS.md`,
// `package.json`). Prose evidence ("local hooks (githooks)", "3 of the last 30 commits: …")
// yields nothing — precision over recall, and the block says so in the command's disclosures.
const FILENAME_RE = /^[^\s:]+\.[A-Za-z0-9]+$/

function extractFiles(evidence: string[]): string[] {
  const files = new Set<string>()
  for (const line of evidence) {
    const token = line.split(/[\s:]/)[0]
    if (token && (token.includes("/") || FILENAME_RE.test(token))) files.add(token)
  }
  return [...files].sort()
}

// The two gate surfaces this tool knows (local hooks, CI); anything else a finding names is a
// file, not a gate, and saying otherwise would invent reach the evidence does not carry.
function extractGates(files: string[]): string[] {
  return files.filter((f) => f.startsWith(".githooks/") || f.startsWith(".github/workflows/"))
}

function reversibility(files: string[]): Implications["reversibility"] {
  if (!files.length) return "undetermined"
  const generated = (f: string) => f.startsWith(".etymd/") || f.startsWith(".githooks/")
  return files.every(generated) ? "regenerable" : "git-reversible"
}

function toProposal(s: Subject, rubric: Rubric): Proposal {
  const matched: MatchedLine[] = []
  let score = 0
  for (const line of rubric.lines) {
    const value = CRITERION_VALUE[line.criterion](s)
    score += line.weight * value
    // A line fires when the subject reads at/above the criterion's midpoint — the lines that
    // argued for the proposal, not merely applied to it.
    if (value >= 2) matched.push({ criterion: line.criterion, weight: line.weight, value })
  }
  const files = extractFiles(s.evidence)
  return {
    id: s.id,
    schema: PROPOSAL_SCHEMA,
    class: s.classId,
    kind: s.kind,
    projects: s.projects,
    action: s.action,
    effort: s.effort,
    confidence: s.confidence,
    score,
    matched,
    implications: {
      projects: s.projects,
      files,
      gates: extractGates(files),
      reversibility: reversibility(files),
    },
  }
}

export interface ProposeResult {
  schema: typeof PROPOSAL_SCHEMA
  manifest: string
  rubric: string
  criteria: RubricLine[]
  proposals: Proposal[]
  disclosures: string[]
}

/**
 * Build the proposals from a sweep result: every `kind: "improvement"` finding from every
 * personal project, plus every recurring class recomputed over personal projects only. Corp
 * entries are excluded from the output entire (their findings, and their names inside class
 * breadth) — a corp improvement is the employer's backlog, not this fleet's proposal queue —
 * and their exclusion is disclosed by name so absence is a stated policy, never a hole.
 */
export function buildProposals(
  sweep: {
    manifest: string
    projects: FleetProjectSweep[]
  },
  rubricName: string,
  rubric: Rubric,
): ProposeResult {
  const disclosures: string[] = []
  const personal = sweep.projects.filter((p) => p.profile === "personal")
  const corp = sweep.projects.filter((p) => p.profile !== "personal")
  if (corp.length) {
    disclosures.push(
      `corp entries excluded from proposals: ${corp
        .map((p) => p.name)
        .sort()
        .join(", ")}`,
    )
  }
  const notAudited = personal.filter((p) => !p.resolvedRoot || p.unresolved)
  if (notAudited.length) {
    disclosures.push(
      `not audited, so not proposed: ${notAudited
        .map((p) => p.name)
        .sort()
        .join(", ")}`,
    )
  }

  const subjects: Subject[] = []
  for (const project of personal) {
    for (const f of project.findings) {
      // Truth findings are not opportunities — a lie is fixed, not ranked (012).
      if (f.kind === "improvement") subjects.push(findingSubject(project, f))
    }
  }

  // Recurring classes recomputed over personal findings only: the stored/engine sweep's own
  // list counts corp projects, and a class held open by corp repos alone is not this fleet's
  // proposal. Same minting as the engine — everything before the first `:` of a finding id.
  const byClass = new Map<string, { project: FleetProjectSweep; finding: Finding }[]>()
  for (const project of personal) {
    for (const f of project.findings) {
      const classId = f.id.split(":")[0] ?? f.id
      const entry = byClass.get(classId) ?? []
      entry.push({ project, finding: f })
      byClass.set(classId, entry)
    }
  }
  for (const [classId, members] of byClass) {
    if (new Set(members.map((m) => m.project.name)).size >= 2) {
      subjects.push(classSubject(classId, members))
    }
  }

  const proposals = subjects
    .map((s) => toProposal(s, rubric))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  return {
    schema: PROPOSAL_SCHEMA,
    manifest: sweep.manifest,
    rubric: rubricName,
    criteria: rubric.lines,
    proposals,
    disclosures: [
      ...disclosures,
      "implications.files are path-shaped tokens extracted from finding evidence — evidence lines carrying no path are not represented there",
    ],
  }
}
