import path from "node:path"

import type { Finding, FindingTier } from "../../engine/finding.js"
import type { ProjectFacts } from "../../core/types.js"
import { git, pathExists, readJson, readText } from "../../core/util.js"
import { parseDecisionEntries } from "../state-freshness.js"
import { extractCommandClaims, extractDocRefs, extractPathClaims } from "./claims.js"

// The command/path/doc-reference truth checks, factored so that every surface that verifies text
// against the repo — instruction files, state documents, and the task an agent is about to be
// handed — runs the SAME precision rules. Two copies of these rules would drift apart, which is
// the exact failure this tool exists to catch.

/** Everything a truth check needs from the repo, resolved once per run. */
export interface TruthEnv {
  root: string
  facts: ProjectFacts
  /** Package scripts across the root and every workspace manifest. */
  knownScripts: Set<string>
  nodeModulesInstalled: boolean
  /** A manifest exists somewhere, so a script claim is checkable even without an install. */
  manifestExists: boolean
  /** A repo-relative claim resolves in the root, any workspace package, or their src/ scripts/. */
  pathResolves(claim: string): Promise<boolean>
  /** `yarn X` / `pnpm X` may legitimately run an installed node_modules/.bin binary. */
  binResolves(name: string): Promise<boolean>
}

export async function buildTruthEnv(root: string, facts: ProjectFacts): Promise<TruthEnv> {
  // Monorepo truth: a script/path claim holds if it resolves in the ROOT or in ANY workspace
  // package — instruction files legitimately name workspace scripts bare and paths relative
  // to the package they discuss.
  const knownScripts = new Set(Object.keys(facts.commands.raw))
  for (const pkg of facts.packages) {
    const pkgJson = await readJson<{ scripts?: Record<string, string> }>(
      path.join(root, pkg.dir, "package.json"),
    )
    for (const key of Object.keys(pkgJson?.scripts ?? {})) knownScripts.add(key)
  }
  const bases = [root, ...facts.packages.map((p) => path.join(root, p.dir))]
  const pathResolves = async (claim: string): Promise<boolean> => {
    for (const base of bases) {
      if (await pathExists(path.join(base, claim))) return true
      // Conventional sub-roots instruction prose is written relative to.
      if (await pathExists(path.join(base, "src", claim))) return true
      if (await pathExists(path.join(base, "scripts", claim))) return true
    }
    return false
  }
  // Without an installed node_modules we cannot tell a stale script from a valid binary, so
  // unknown commands are then skipped and disclosed, never accused.
  const binResolves = async (name: string): Promise<boolean> => {
    for (const base of bases) {
      if (await pathExists(path.join(base, "node_modules", ".bin", name))) return true
    }
    return false
  }
  const nodeModulesInstalled = await pathExists(path.join(root, "node_modules"))
  // A repo with no package manifest anywhere can never install node_modules, so nothing could
  // ever satisfy a script claim there — checkable (and false) even without an install.
  const manifestExists =
    (await pathExists(path.join(root, "package.json"))) || facts.packages.length > 0
  return {
    root,
    facts,
    knownScripts,
    nodeModulesInstalled,
    manifestExists,
    pathResolves,
    binResolves,
  }
}

/** Skip-class tallies — every class a check declines to accuse is counted, then disclosed. */
export interface ClaimCounters {
  filteredSkipped: number
  tildeSkipped: number
  binaryResolved: number
  unverifiableCommands: number
  gitignoredSkipped: number
  prospectiveSkipped: number
  placeholderSkipped: number
}

export function emptyCounters(): ClaimCounters {
  return {
    filteredSkipped: 0,
    tildeSkipped: 0,
    binaryResolved: 0,
    unverifiableCommands: 0,
    gitignoredSkipped: 0,
    prospectiveSkipped: 0,
    placeholderSkipped: 0,
  }
}

/** A piece of text making claims about the repo: an instruction file, a state doc, a task. */
export interface ClaimText {
  /** Repo-relative path, or a label such as `task` — becomes part of every finding id. */
  path: string
  text: string
}

export interface TextClaimsOptions {
  /** The lens the findings report under (`instruction-truth`, `premise`). */
  lensId: string
  /** How the text is named in a claim sentence — a file path, or "The task". */
  subject?: string
  /**
   * A missing path is `gap` for an instruction file (a dead reference among many) and `risk` for
   * a task (the task is ABOUT the path — an agent acting on it does the wrong thing).
   */
  missingPathTier: FindingTier
  maxPathFindings: number
  whyCommand?: string
  actionCommand?: string
  whyPath?: string
  actionPath?: string
}

export interface TextClaimsResult {
  findings: Finding[]
  disclosures: string[]
}

/**
 * Command and path claims in one text, verified against the repo. Precision over recall: every
 * class it declines to accuse is counted in `counters` for the caller to disclose.
 */
export async function checkTextClaims(
  env: TruthEnv,
  file: ClaimText,
  opts: TextClaimsOptions,
  counters: ClaimCounters,
): Promise<TextClaimsResult> {
  const findings: Finding[] = []
  const disclosures: string[] = []
  const subject = opts.subject ?? file.path

  // Command claims: a script the text tells agents to run must exist somewhere real.
  const { scripts: claimed, filteredSkipped } = extractCommandClaims(file.text)
  counters.filteredSkipped += filteredSkipped
  for (const [script, raw] of claimed) {
    if (env.knownScripts.has(script)) continue
    if (await env.binResolves(script)) {
      counters.binaryResolved += 1
      continue
    }
    if (!env.nodeModulesInstalled && env.manifestExists) {
      counters.unverifiableCommands += 1
      continue
    }
    findings.push({
      lens: opts.lensId,
      id: `${opts.lensId}/stale-command:${file.path}:${script}`,
      tier: "risk",
      claim: `${subject} tells agents to run \`${script}\` — no such script exists`,
      evidence: [`${file.path}: \`${raw}\``, "package.json scripts (root + workspaces)"],
      why:
        opts.whyCommand ??
        "An agent following this instruction runs a command that fails — or silently skips the check it was meant to run.",
      action:
        opts.actionCommand ??
        "Update the instruction to the current script name (or restore the script).",
      effort: "S",
      confidence: "high",
    })
  }

  // Path claims: a path the text points agents at must exist.
  const { paths, prospective, placeholder } = extractPathClaims(file.text)
  counters.prospectiveSkipped += prospective.length
  counters.placeholderSkipped += placeholder.length
  const missing: string[] = []
  for (const claim of paths) {
    if (!(await env.pathResolves(claim))) missing.push(claim)
  }
  // A gitignored claim (`.env`, local caches) is machine-local by design: absence in THIS
  // checkout does not make the text false — unverifiable, so skipped, never accused.
  // check-ignore exits non-zero when nothing matches; git() maps that to null.
  const ignoredOut = missing.length ? await git(env.root, ["check-ignore", ...missing]) : null
  const gitignored = new Set((ignoredOut ?? "").split("\n").filter(Boolean))
  let pathFindings = 0
  for (const claim of missing) {
    if (gitignored.has(claim)) {
      counters.gitignoredSkipped += 1
      continue
    }
    if (pathFindings >= opts.maxPathFindings) {
      disclosures.push(
        `${file.path}: more than ${opts.maxPathFindings} missing-path claims — truncated.`,
      )
      break
    }
    pathFindings += 1
    findings.push({
      lens: opts.lensId,
      id: `${opts.lensId}/stale-path:${file.path}:${claim}`,
      tier: opts.missingPathTier,
      claim: `${subject} references \`${claim}\` — it does not exist in the repo`,
      evidence: [file.path, `missing: ${claim}`],
      why:
        opts.whyPath ??
        "Agents navigate by these references; a dead path wastes a lookup and erodes trust in the rest of the file.",
      action: opts.actionPath ?? "Fix or remove the reference.",
      effort: "S",
      confidence: "medium",
    })
  }

  return { findings, disclosures }
}

/** Cross-references to well-known docs (AGENTS.md, CLAUDE.md, …) must resolve to real files. */
export async function checkDocRefs(
  env: TruthEnv,
  file: ClaimText,
  lensId: string,
  counters: ClaimCounters,
  subject = file.path,
): Promise<Finding[]> {
  const findings: Finding[] = []
  const { refs, tildeSkipped } = extractDocRefs(file.text)
  counters.tildeSkipped += tildeSkipped
  for (const ref of refs) {
    if (await pathExists(path.join(env.root, ref))) continue
    findings.push({
      lens: lensId,
      id: `${lensId}/dangling-ref:${file.path}:${ref}`,
      tier: "gap",
      claim: `${subject} references ${ref} — no such file exists`,
      evidence: [file.path, `missing: ${ref}`],
      why: "The pointer chain agents follow breaks at a file they can never read.",
      action: `Create ${ref} or remove the reference.`,
      effort: "S",
      confidence: "high",
    })
  }
  return findings
}

/** The repo's own decision record: every `## D-NNN` id, and which files carried them. */
export interface DecisionLedger {
  /** Null when no decisions file with parseable `## D-NNN` entries exists. */
  ids: Set<number> | null
  sources: string[]
}

export async function loadDecisionLedger(
  root: string,
  facts: ProjectFacts,
): Promise<DecisionLedger> {
  let ids: Set<number> | null = null
  const sources: string[] = []
  for (const artifact of facts.artifacts) {
    if (artifact.kind !== "decisions" || !artifact.exists) continue
    // Directory conventions read as null — they carry no parseable `## D-NNN` ids.
    const text = await readText(path.join(root, artifact.path))
    if (text === null) continue
    const entries = parseDecisionEntries(text)
    if (!entries.length) continue
    ids ??= new Set()
    for (const entry of entries) ids.add(entry.num)
    sources.push(artifact.path)
  }
  return { ids, sources }
}
