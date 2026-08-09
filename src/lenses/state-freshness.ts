import path from "node:path"

import { CONFIG_FILE, DEFAULT_CONFIG } from "../core/config.js"
import { readText } from "../core/util.js"
import type { Finding, Lens, LensReport } from "../engine/finding.js"

const LENS_ID = "state-freshness"

/**
 * The marker that opts a decisions file into per-entry format checks. Forward-only by design:
 * mandatory-field checks apply to files that declared the format, never retroactively to
 * pre-existing records — old decisions are history, not defects.
 *
 * A file may append `fields=A,B` to require field names of its own choosing on every entry at or
 * after the marker — position is the gate, so a marker moved down the file exempts the history
 * above it and one left at the top governs the whole file.
 * Etymd ships no vocabulary for those names and attaches no meaning to them: it checks only that
 * a field the file itself declared is present. A marker with no `fields=` behaves as it always
 * has, so the attribute is an extension rather than a new format version.
 */
export const DECISIONS_FORMAT_MARKER = "<!-- decisions-format: 1 -->"

/** The version this build understands; a higher one is honoured as v1 and disclosed, never guessed at. */
const KNOWN_FORMAT_VERSION = 1

const MARKER_RE = /<!--\s*decisions-format:\s*(\d+)([^>]*?)-->/

/** Declarable field names. Narrow on purpose: no regex metacharacters can reach the matcher. */
const FIELD_NAME_RE = /^[A-Za-z0-9 _-]+$/

/**
 * `Scope` is checked natively, so a file redeclaring it would earn two findings for one
 * missing line. Compared case-insensitively, as declared names are.
 */
const BUILT_IN_FIELDS = new Set(["scope"])

const MS_PER_DAY = 86_400_000

interface DecisionEntry {
  /** "D-007" as written. */
  id: string
  num: number
  /** Body between this `## D-NNN` heading and the next `## ` heading. */
  block: string
  /** Character offset of the `## D-NNN` heading — compared against the marker's own offset. */
  offset: number
}

interface DecisionsFormat {
  /** Extra field names this file requires on every entry, in declaration order. */
  fields: string[]
  /** Character offset of the marker itself: field requirements bind entries at or after it. */
  offset: number
  /** Marker text this build could not use. Disclosed by the lens, never silently dropped. */
  problems: string[]
}

/**
 * Read the format marker. Returns null when the file carries none — the forward-only gate.
 *
 * The marker's own offset is part of the result: forward-only is a claim about POSITION, not
 * merely about the file. A ledger that declares new required fields mid-life cannot backfill the
 * entries already appended above the marker, so only entries at or after it are bound.
 *
 * Everything unusable in the marker becomes a `problem` rather than a silent fallback: a file
 * that believes it declared a required field, and is quietly audited without it, would read as
 * clean for the one reason this tool exists to reject.
 */
function parseDecisionsFormat(text: string): DecisionsFormat | null {
  const m = MARKER_RE.exec(text)
  if (!m) return null

  const problems: string[] = []
  const fields: string[] = []
  const offset = m.index ?? 0

  const version = Number(m[1])
  if (version !== KNOWN_FORMAT_VERSION) {
    problems.push(
      `declares decisions-format version ${version}; this etymd understands version ${KNOWN_FORMAT_VERSION} — checked as version ${KNOWN_FORMAT_VERSION}.`,
    )
  }

  const attrs = (m[2] ?? "").trim()
  if (!attrs) return { fields, offset, problems }

  const declared = /^fields=(.*)$/.exec(attrs)
  if (!declared) {
    problems.push(`marker attribute \`${attrs}\` is not understood — ignored (only \`fields=\`).`)
    return { fields, offset, problems }
  }

  const seen = new Set(BUILT_IN_FIELDS)
  for (const raw of (declared[1] as string).split(",")) {
    const name = raw.trim()
    if (!name) continue
    if (!FIELD_NAME_RE.test(name)) {
      problems.push(
        `declared field \`${name}\` is not a usable field name (letters, digits, spaces, \`-\`, \`_\`) — not checked.`,
      )
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    fields.push(name)
  }

  if (fields.length === 0 && problems.length === 0) {
    problems.push("marker declares `fields=` with no field names — no extra fields checked.")
  }
  return { fields, offset, problems }
}

/** Presence test for one declared field, matching the built-in `Scope:` shape (`**Name:**` counts). */
function hasField(block: string, name: string): boolean {
  return new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s*]*:`).test(block)
}

function parseDecisionEntries(text: string): DecisionEntry[] {
  const headings = [...text.matchAll(/^## .*$/gm)]
  const entries: DecisionEntry[] = []
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i] as RegExpMatchArray
    const m = /^## (D-(\d+))\b/.exec(h[0])
    if (!m) continue
    const offset = h.index ?? 0
    const start = offset + h[0].length
    const end = i + 1 < headings.length ? (headings[i + 1] as RegExpMatchArray).index : undefined
    entries.push({ id: m[1] as string, num: Number(m[2]), block: text.slice(start, end), offset })
  }
  return entries
}

/**
 * Id-sequence checks (duplicate ids, append order) on any file using `## D-NNN` headings.
 * Deliberately NOT marker-gated: an append race is a defect in the file's own chosen
 * convention, not a format opinion — self-healing must reach legacy files too.
 */
function checkIdSequence(file: string, entries: DecisionEntry[]): Finding[] {
  const findings: Finding[] = []
  const nextFree = Math.max(0, ...entries.map((e) => e.num)) + 1

  const seen = new Map<number, DecisionEntry>()
  const duplicated = new Set<number>()
  let prev: DecisionEntry | undefined
  for (const entry of entries) {
    if (seen.has(entry.num)) {
      if (!duplicated.has(entry.num)) {
        duplicated.add(entry.num)
        findings.push({
          id: `${LENS_ID}/duplicate-id:${file}:${entry.id}`,
          lens: LENS_ID,
          tier: "gap",
          claim: `${file} carries more than one ${entry.id} entry`,
          evidence: [`${file}: ${entry.id} appears twice`],
          why: "Two decisions under one id cannot be cited, superseded, or dismissed unambiguously — append races collide exactly here.",
          action: `Rename the later entry to D-${String(nextFree).padStart(3, "0")} (the next free id).`,
          effort: "S",
          confidence: "high",
        })
      }
    } else {
      seen.set(entry.num, entry)
      if (prev && entry.num < prev.num) {
        findings.push({
          id: `${LENS_ID}/id-order:${file}:${entry.id}`,
          lens: LENS_ID,
          tier: "gap",
          claim: `${file} lists ${entry.id} after ${prev.id} — ids out of append order`,
          evidence: [`${file}: ${prev.id} precedes ${entry.id}`],
          why: "An append-only record reads in id order; out-of-order ids make the newest decision hard to find and the next id hard to pick.",
          action: `Rename the out-of-order entry into sequence (next free id: D-${String(nextFree).padStart(3, "0")}).`,
          effort: "S",
          confidence: "high",
        })
      }
      prev = entry
    }
  }
  return findings
}

/**
 * Format-field checks (Scope presence, Revisit, and any field the file declared) — marker-gated,
 * forward-only by design. Enforcement is deterministic: no heuristic decides which entries "look
 * like" they need a field, because a keyword trigger would flag prose that merely mentions the
 * wrong word, and a false "your file is lying" costs more than a missed one.
 *
 * Forward-only is measured from the marker's POSITION, not from the file: presence requirements
 * bind only entries whose heading starts at or after it. A marker at the top of the file therefore
 * governs everything, which is what a file that declared the format from the start intends; a
 * marker moved down mid-life exempts the history above it, which an append-only record cannot
 * rewrite. `Revisit:` is deliberately not position-gated — it fires only where the field is
 * already present, and a date the entry itself promised is due whenever it was written.
 */
function checkFormatFields(
  file: string,
  entries: DecisionEntry[],
  today: string,
  declaredFields: string[],
  markerOffset: number,
): Finding[] {
  const findings: Finding[] = []
  for (const entry of entries) {
    const bound = entry.offset >= markerOffset
    for (const field of bound ? declaredFields : []) {
      if (hasField(entry.block, field)) continue
      findings.push({
        id: `${LENS_ID}/field-missing:${file}:${entry.id}:${field}`,
        lens: LENS_ID,
        tier: "gap",
        claim: `${file} ${entry.id} has no ${field}: field`,
        evidence: [`${file}: ${entry.id}`, `${file} marker declares required field \`${field}\``],
        why: "The file declares this field required on every entry after the marker; whatever reads the record for it finds nothing here.",
        action: `Add a ${field}: line to ${entry.id}.`,
        effort: "S",
        confidence: "high",
      })
    }

    if (bound && !/Scope[\s*]*:/.test(entry.block)) {
      findings.push({
        id: `${LENS_ID}/scope-missing:${file}:${entry.id}`,
        lens: LENS_ID,
        tier: "gap",
        claim: `${file} ${entry.id} has no Scope: field`,
        evidence: [`${file}: ${entry.id}`],
        why: "A decision without a scope binds nobody — a reader cannot tell whether it covers the project they are working in.",
        action: "Add a Scope: line naming what the decision binds.",
        effort: "S",
        confidence: "high",
      })
    }

    const revisit = /Revisit[\s*]*:[\s*]*(\d{4}-\d{2}-\d{2})/.exec(entry.block)
    if (revisit && (revisit[1] as string) < today) {
      findings.push({
        id: `${LENS_ID}/revisit-due:${file}:${entry.id}`,
        lens: LENS_ID,
        tier: "gap",
        claim: `${file} ${entry.id} was due for revisit on ${revisit[1]}`,
        evidence: [`${file}: ${entry.id} Revisit: ${revisit[1]}`],
        why: "Review debt is due — a Revisit date is a promise to re-evaluate, and a past one silently hardens into policy.",
        action: "Re-evaluate the decision: supersede it or move the Revisit date.",
        effort: "S",
        confidence: "high",
      })
    }
  }
  return findings
}

/**
 * Freshness lens: does the layer that claims "this describes now" still describe now? Staleness
 * is RELATIVE — a state doc is stale only when the repo moved past it, so a dormant repo's old
 * state is current by definition and produces zero findings. Every date is a git committer date
 * (never mtime); everything git cannot vouch for is disclosed, never flagged.
 */
export const stateFreshnessLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "State freshness",
  kind: "truth",
  async run(ctx): Promise<LensReport> {
    const budgets = ctx.config?.config.state ?? DEFAULT_CONFIG.state
    const findings: Finding[] = []
    const disclosures: string[] = [...(ctx.config?.problems ?? [])]
    const outOfScope: string[] = []
    const today = new Date().toISOString().slice(0, 10)

    const stateArtifacts = ctx.facts.artifacts.filter((a) => a.kind === "state" && a.exists)
    const decisionArtifacts = ctx.facts.artifacts.filter((a) => a.kind === "decisions" && a.exists)
    if (stateArtifacts.length === 0 && decisionArtifacts.length === 0) {
      disclosures.push("No state or decisions artifacts detected — nothing to check.")
    }

    // ---- relative staleness (state artifacts only; decisions are exempt from age) ----
    const freshness = ctx.facts.freshness
    if (!freshness) {
      disclosures.push("Scan carried no freshness facts — staleness unchecked.")
    } else {
      for (const u of freshness.unverifiable) {
        disclosures.push(`Freshness of ${u.path} is unverifiable (${u.reason}) — not flagged.`)
      }
      for (const a of stateArtifacts) {
        const fact = freshness.artifacts.find((f) => f.artifactId === a.id)
        if (!fact || !freshness.repoLastCommit) continue // absence disclosed above
        if (fact.dirty) {
          // The refresh is on disk, uncommitted — flagging it stale would punish the exact
          // moment the doc was just brought current (e.g. an audit in a pre-commit gate).
          disclosures.push(
            `${a.path} has uncommitted changes — modified since its last commit; treated fresh-now, not flagged.`,
          )
          continue
        }
        if (!fact.commitsSince) continue // dormant repo: old state is current state
        const gapDays = Math.floor(
          (Date.parse(freshness.repoLastCommit) - Date.parse(fact.lastCommit)) / MS_PER_DAY,
        )
        if (gapDays <= budgets.staleAfterDays) continue
        const escalated = gapDays > budgets.staleAfterDays * 3
        findings.push({
          id: `${LENS_ID}/stale-state:${a.path}`,
          lens: LENS_ID,
          tier: escalated ? "risk" : "gap",
          claim: `${a.path} trails the repo by ${gapDays} days of commit traffic — it says "now" but the repo moved on`,
          evidence: [
            `${a.path} last commit: ${fact.lastCommit}`,
            `repo last commit: ${freshness.repoLastCommit}`,
          ],
          why: escalated
            ? `Over three times the ${budgets.staleAfterDays}-day threshold while commits kept landing — every session starts from a picture of the project that is no longer true.`
            : `A state doc more than ${budgets.staleAfterDays} days behind continued commit traffic misleads every session that loads it.`,
          action: "Refresh the state doc (or record why it is still current).",
          effort: "S",
          confidence: "high",
        })
      }
    }

    // ---- state char budget (session-injection hooks truncate around 10,000 chars) ----
    for (const a of stateArtifacts) {
      const text = await readText(path.join(ctx.root, a.path))
      if (text === null) {
        disclosures.push(`${a.path} could not be read — unexamined, not clean.`)
        outOfScope.push(a.path)
        continue
      }
      if (text.length > budgets.maxChars) {
        findings.push({
          id: `${LENS_ID}/state-over-budget:${a.path}`,
          lens: LENS_ID,
          tier: "gap",
          claim: `${a.path} is ${text.length} chars — over the ${budgets.maxChars}-char state budget`,
          evidence: [`${a.path}: ${text.length} chars`],
          why: "Session-injection hooks truncate state around 10,000 chars — an over-budget state doc gets cut mid-sentence, and every session pays its full weight before the task begins.",
          action: "Trim to budget; move overflow into decisions/docs and keep a pointer.",
          effort: "M",
          confidence: "high",
        })
      }
    }

    // ---- decisions checks: id sequence always; format fields marker-gated, forward-only ----
    for (const a of decisionArtifacts) {
      const text = await readText(path.join(ctx.root, a.path))
      if (text === null) {
        // Directory conventions (docs/adr/ …): recognized and age-exempt; not parsed per entry.
        disclosures.push(
          `${a.path} recognized as a decisions convention (directory) — age-exempt; per-entry format checks apply only to marker-carrying decisions files.`,
        )
        continue
      }
      const entries = parseDecisionEntries(text)
      findings.push(...checkIdSequence(a.path, entries))
      const format = parseDecisionsFormat(text)
      if (!format) {
        disclosures.push(
          `${a.path} carries no \`${DECISIONS_FORMAT_MARKER}\` marker — format checks skipped (forward-only, never retroactive); id-sequence checks still ran.`,
        )
        outOfScope.push(a.path)
        continue
      }
      for (const problem of format.problems) disclosures.push(`${a.path}: ${problem}`)
      const exempt = entries.filter((e) => e.offset < format.offset)
      if (format.fields.length > 0) {
        disclosures.push(
          `${a.path} declares required entry fields: ${format.fields.join(", ")} — checked on every entry at or after the marker (etymd attaches no meaning to the names).`,
        )
      }
      if (exempt.length > 0) {
        // Named, not just counted: an entry exempt by position is unchecked, not clean.
        disclosures.push(
          `${a.path}: ${exempt.length} entr${exempt.length === 1 ? "y" : "ies"} precede the format marker (${exempt[0]?.id}…${exempt[exempt.length - 1]?.id}) — field presence not checked there (forward-only from the marker's position).`,
        )
      }
      findings.push(...checkFormatFields(a.path, entries, today, format.fields, format.offset))
    }

    disclosures.push(
      `Thresholds: staleAfterDays ${budgets.staleAfterDays} (3x escalates to risk), state budget ${budgets.maxChars} chars (${
        budgets.staleAfterDays === DEFAULT_CONFIG.state.staleAfterDays &&
        budgets.maxChars === DEFAULT_CONFIG.state.maxChars
          ? `defaults — override under \`state\` in ${CONFIG_FILE}`
          : `set in ${CONFIG_FILE}`
      }). Decisions artifacts are exempt from age — old decisions are history, not defects.`,
    )

    return {
      lens: LENS_ID,
      version: "1",
      title: "State freshness",
      kind: "truth",
      status: "ran",
      disclosures,
      findings,
      ...(outOfScope.length ? { outOfScope } : {}),
    }
  },
}
