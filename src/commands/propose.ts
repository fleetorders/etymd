import path from "node:path"

import { loadFleetManifest } from "../core/fleet.js"
import { readText } from "../core/util.js"
import { FLEET_JSON_SCHEMA, sweepFleet, type FleetProjectSweep } from "../engine/fleet.js"
import { buildProposals, parseRubric, type ProposeResult } from "../engine/propose.js"
import { print, renderFleetNotes, section } from "../ui/render.js"
import { theme } from "../ui/theme.js"

// `etymd propose` — score the sweep's improvement findings and recurring classes against a
// fleet-authored rubric and emit proposal records. A thin adapter: the manifest/from-file
// decision, the read-only sweep, then the engine's pure functions. No ledger, no baseline, no
// last.fleet.json — propose observes and scores, it never writes.

export interface ProposeCmdOptions {
  cwd: string
  manifest?: string
  from?: string
  rubric: string
  json?: boolean
}

/**
 * A stored sweep (`etymd fleet --json` output). Only the project rows are consumed; the schema
 * marker is checked so a foreign file is refused rather than misread — the same refusal the
 * delta baseline applies to itself.
 */
async function readStoredSweep(
  abs: string,
): Promise<{ manifest: string; projects: FleetProjectSweep[] }> {
  const raw = await readText(abs)
  if (raw === null) throw new Error(`cannot read the stored sweep: ${abs}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `${abs} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  const rec = parsed as Partial<{
    schema: string
    manifest: string
    projects: FleetProjectSweep[]
  }> | null
  if (
    typeof rec !== "object" ||
    rec === null ||
    rec.schema !== FLEET_JSON_SCHEMA ||
    !Array.isArray(rec.projects)
  ) {
    throw new Error(
      `${abs} is not a stored fleet sweep (schema ${FLEET_JSON_SCHEMA}) — write one with \`etymd fleet --json\``,
    )
  }
  return { manifest: rec.manifest ?? abs, projects: rec.projects }
}

export async function run(opts: ProposeCmdOptions): Promise<void> {
  if (!opts.manifest && !opts.from) {
    throw new Error(
      "propose needs a sweep: pass --manifest <registry.json> (runs one now, read-only) or --from <fleet.json> (reads a stored `etymd fleet --json` output)",
    )
  }
  if (opts.manifest && opts.from) {
    throw new Error(
      "--manifest and --from are alternatives — a fresh sweep or a stored one, not both",
    )
  }

  const rubricPath = path.resolve(opts.cwd, opts.rubric)
  const rubricText = await readText(rubricPath)
  if (rubricText === null) throw new Error(`cannot read the rubric: ${rubricPath}`)
  const rubric = parseRubric(rubricText, opts.rubric)

  const swept = opts.from
    ? await readStoredSweep(path.resolve(opts.cwd, opts.from))
    : await sweepFleet(await loadFleetManifest(path.resolve(opts.cwd, opts.manifest as string)))

  const result = buildProposals(swept, opts.rubric, rubric)
  if (opts.json) {
    print(JSON.stringify(result, null, 2))
    return
  }
  render(result)
}

function render(result: ProposeResult): void {
  section(
    `Proposals ${theme.dim(`· ${path.basename(result.manifest)} · rubric ${result.rubric} (${result.criteria.map((l) => `${l.criterion}:${l.weight}`).join(", ")}) · ${result.proposals.length} proposal(s) · schema ${result.schema} (EXPERIMENTAL)`)}`,
  )
  if (!result.proposals.length) {
    print(`  ${theme.dim("nothing to propose — no improvement findings or recurring classes")}`)
  }
  for (const p of result.proposals) {
    const who =
      p.kind === "class"
        ? `${p.class} ${theme.dim(`— class, ${p.projects.length}×: ${p.projects.join(", ")}`)}`
        : `${p.id} ${theme.dim(`— ${p.projects.join(", ")}`)}`
    print(`  ${theme.info(String(p.score).padStart(3))}  ${who}`)
    print(
      `        ${theme.dim(`${p.effort} · ${p.confidence} · fired: ${p.matched.map((m) => `${m.criterion}(${m.value}/3)`).join(", ") || "—"}`)}`,
    )
    if (p.action) print(`        ${theme.dim(p.action)}`)
    const im = p.implications
    print(
      `        ${theme.dim(`implications: ${im.projects.length} project(s) · files: ${im.files.join(", ") || "—"} · gates: ${im.gates.join(", ") || "—"} · ${im.reversibility}`)}`,
    )
  }
  renderFleetNotes([], result.disclosures)
}
