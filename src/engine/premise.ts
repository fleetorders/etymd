import path from "node:path"

import { ETYMD_DIR } from "../core/facts.js"
import { scanProject } from "../core/scan.js"
import { pathExists } from "../core/util.js"
import {
  buildTruthEnv,
  checkDocRefs,
  checkTextClaims,
  emptyCounters,
  loadDecisionLedger,
} from "../lenses/instruction-truth/checks.js"
import {
  extractCommandClaims,
  extractDecisionRefs,
  extractDocRefs,
  extractPathClaims,
} from "../lenses/instruction-truth/claims.js"
import { rankFindings, type Finding } from "./finding.js"

// `etymd premise` — the task an agent is about to be handed is an instruction too (decision 010).
// Before anything acts on it, the things it NAMES are checked against the repo with the same
// precision rules instruction files get; the premises only an agent can verify — that the named
// things are the ones meant, that the mechanism the task assumes actually runs, that the state it
// assumes holds — are handed over in a brief, never guessed at here. Reading files is the whole
// of what this command does (decision 005: anything beyond that is out of scope by construction).

export const PREMISE_LENS = "premise"
export const PREMISE_BRIEF_FILE = path.join(ETYMD_DIR, "premise-brief.md")
const TASK_LABEL = "task"
const MAX_PATH_FINDINGS = 15

export interface PremiseEntity {
  kind: "script" | "path" | "doc" | "decision"
  value: string
  /** `null` = could not be checked from the repo (disclosed), never a guess. */
  exists: boolean | null
}

export interface PremiseResult {
  /** The `--json` schema version. */
  schema: "premise/1"
  task: string
  /** Where the task came from: `argument` or the file path it was read from. */
  source: string
  /** The project name from the reckoning. */
  name: string
  findings: Finding[]
  disclosures: string[]
  /** Everything the task named that etymd could look for — found or not. */
  entities: PremiseEntity[]
  brief: string
  /** Repo-relative path the brief was written to, or `null` when the repo never opted in. */
  briefPath: string | null
}

export interface PremiseOptions {
  root: string
  task: string
  source?: string
  /** Write the brief under `.etymd/` when that directory exists (default true). */
  writeBrief?: boolean
}

const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]+`)/g
// A bare token with a directory separator is a path mention even in plain prose; a bare file
// name without one (`config.ts`, `Node.js`) is prose unless the author backticks it — the same
// precision rule the instruction-file extractor applies to extensionless tokens.
const PATHISH_RE = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@$-]+)+\/?$/
const COMMAND_RE = /\b(?:pnpm|yarn|npm|bun)\s+(?:run\s+)?(?!-)[A-Za-z0-9:._-]+/g
const WRAP_RE = /^([([{"']*)(.*?)([.,;:!?)\]}"']*)$/

/**
 * People do not backtick paths in a prompt. Promote the bare mentions the claim extractors would
 * otherwise treat as prose — `src/x.ts`, `docs/`, `npm run lint` — into code spans, leaving
 * anything already in a code span untouched. The extractors' own filters still decide what counts.
 */
export function promoteBareTokens(text: string): string {
  return text
    .split(CODE_SPAN_RE)
    .map((segment, i) => (i % 2 === 1 ? segment : promoteProse(segment)))
    .join("")
}

function promoteProse(segment: string): string {
  // A sentence-ending stop is not part of the script name: `npm run build.` names `build`.
  const withCommands = segment.replace(COMMAND_RE, (m) => {
    const trail = /[.,;:!?)\]}"']*$/.exec(m)?.[0] ?? ""
    const core = trail ? m.slice(0, -trail.length) : m
    return `\`${core}\`${trail}`
  })
  return withCommands.replace(/[^\s`]+/g, (token) => {
    const m = WRAP_RE.exec(token)
    if (!m) return token
    const [, lead = "", core = "", trail = ""] = m
    if (!core || core.includes("://") || !PATHISH_RE.test(core)) return token
    return `${lead}\`${core}\`${trail}`
  })
}

export async function runPremise(opts: PremiseOptions): Promise<PremiseResult> {
  const root = opts.root
  const task = opts.task.trim()
  const facts = await scanProject(root)
  const env = await buildTruthEnv(root, facts)
  const counters = emptyCounters()
  const text = { path: TASK_LABEL, text: promoteBareTokens(task) }

  const findings: Finding[] = []
  const disclosures: string[] = []

  const claims = await checkTextClaims(
    env,
    text,
    {
      lensId: PREMISE_LENS,
      subject: "The task",
      missingPathTier: "risk",
      maxPathFindings: MAX_PATH_FINDINGS,
      whyCommand:
        "The task is built on a command that does not exist — an agent will run it and fail, or quietly substitute something else and report success.",
      actionCommand: "Fix the task before handing it over: name the real script, or restore it.",
      whyPath:
        "The task is ABOUT this path. Acting on it means editing, testing, or reasoning about something that is not there — the wrong problem, solved precisely.",
      actionPath: "Find where the behaviour actually lives and rewrite the task to name it.",
    },
    counters,
  )
  findings.push(...claims.findings)
  disclosures.push(...claims.disclosures)
  findings.push(...(await checkDocRefs(env, text, PREMISE_LENS, counters, "The task")))

  // Decision references: a task citing a ruling the record never wrote presupposes a decision
  // that does not exist.
  const ledger = await loadDecisionLedger(root, facts)
  const { refs, qualifiedSkipped } = extractDecisionRefs(task)
  for (const [num, asWritten] of refs) {
    if (ledger.ids === null || ledger.ids.has(num)) continue
    findings.push({
      lens: PREMISE_LENS,
      id: `${PREMISE_LENS}/dead-decision-ref:${TASK_LABEL}:${asWritten}`,
      tier: "gap",
      claim: `The task cites ${asWritten} — no such entry exists in ${ledger.sources.join(", ")}`,
      evidence: [TASK_LABEL, `${ledger.sources.join(", ")}: no ${asWritten} entry`],
      why: "The task presupposes a ruling that was never recorded; an agent will act on a decision nobody made.",
      action: "Point the task at the entry that exists — or record the missing decision first.",
      effort: "S",
      confidence: "medium",
    })
  }

  // What the task named, found or not — the checked half of the brief.
  const entities: PremiseEntity[] = []
  const { scripts } = extractCommandClaims(text.text)
  for (const script of scripts.keys()) {
    const known = env.knownScripts.has(script) || (await env.binResolves(script))
    const unverifiable = !known && !env.nodeModulesInstalled && env.manifestExists
    entities.push({ kind: "script", value: script, exists: unverifiable ? null : known })
  }
  const { paths } = extractPathClaims(text.text)
  for (const claim of paths) {
    entities.push({ kind: "path", value: claim, exists: await env.pathResolves(claim) })
  }
  for (const ref of extractDocRefs(text.text).refs) {
    entities.push({ kind: "doc", value: ref, exists: await pathExists(path.join(root, ref)) })
  }
  for (const [num, asWritten] of refs) {
    entities.push({
      kind: "decision",
      value: asWritten,
      exists: ledger.ids === null ? null : ledger.ids.has(num),
    })
  }

  // Honest coverage — every class not checked is named, never silently dropped.
  if (!entities.length) {
    disclosures.push(
      "The task names no path with a directory, no package script, no well-known doc, and no decision id — nothing etymd can check by reading the repo. Everything it presupposes is in the brief.",
    )
  }
  disclosures.push(
    "Bare file names without a directory (e.g. a lone `config.ts`) are read as prose unless backticked; paths with a separator and `npm run` / `pnpm` / `yarn` invocations are checked as written.",
  )
  if (counters.unverifiableCommands) {
    disclosures.push(
      `node_modules is not installed — ${counters.unverifiableCommands} command(s) matching no package script could not be checked against installed binaries; skipped, not flagged.`,
    )
  }
  if (counters.binaryResolved) {
    disclosures.push(
      `${counters.binaryResolved} command(s) resolve to installed binaries (node_modules/.bin), not package scripts — treated as true.`,
    )
  }
  if (counters.gitignoredSkipped) {
    disclosures.push(
      `${counters.gitignoredSkipped} missing path(s) are gitignored (machine-local) — existence is not verifiable from the repo; skipped, not flagged.`,
    )
  }
  if (counters.prospectiveSkipped) {
    disclosures.push(
      `${counters.prospectiveSkipped} path(s) sit in create-this prose (the task says to create them) — forward-looking, not missing; skipped.`,
    )
  }
  if (counters.placeholderSkipped) {
    disclosures.push(
      `${counters.placeholderSkipped} path(s) are naming stand-ins (e.g. \`my-feature\`) rather than real references; skipped.`,
    )
  }
  if (counters.filteredSkipped) {
    disclosures.push(
      `${counters.filteredSkipped} workspace-filtered command(s) (\`--filter\`, \`-C\` …) were not resolved; skipped.`,
    )
  }
  if (qualifiedSkipped) {
    disclosures.push(
      `${qualifiedSkipped} decision reference(s) name another record — not this repo's; skipped.`,
    )
  }
  if (refs.size && ledger.ids === null) {
    disclosures.push(
      `${refs.size} decision reference(s) could not be resolved — no decisions file with \`## D-NNN\` entries; skipped, not flagged.`,
    )
  }
  disclosures.push(
    "What the task PRESUPPOSES — that the named things are the ones meant, that the mechanism it assumes actually runs, that the state it assumes holds — cannot be checked by reading files. The brief hands those to the agent.",
  )
  disclosures.push("Task findings are not remembered between runs — no ledger is written.")

  const ranked = rankFindings(findings)
  const brief = renderBrief(task, ranked, entities)

  let briefPath: string | null = null
  if (opts.writeBrief !== false && (await pathExists(path.join(root, ETYMD_DIR)))) {
    // A repo that never opted in (`etymd init`) takes zero writes; the brief goes to stdout.
    const { promises: fs } = await import("node:fs")
    await fs.writeFile(path.join(root, PREMISE_BRIEF_FILE), brief, "utf8")
    briefPath = PREMISE_BRIEF_FILE
  }

  return {
    schema: "premise/1",
    task,
    source: opts.source ?? "argument",
    name: facts.name,
    findings: ranked,
    disclosures,
    entities,
    brief,
    briefPath,
  }
}

function mark(exists: boolean | null): string {
  return exists === null ? "?" : exists ? "✓" : "✗"
}

function kindLabel(kind: PremiseEntity["kind"]): string {
  return kind === "script" ? "script " : kind === "decision" ? "decision " : ""
}

/**
 * The half of the premise check only an agent can do, written as a brief it reads before acting.
 * Deterministic: it lists what etymd verified and hands over the three questions reading files
 * cannot answer. It never speculates about what the task "really" means.
 */
export function renderBrief(task: string, findings: Finding[], entities: PremiseEntity[]): string {
  const title = task.length > 100 ? `${task.slice(0, 97)}…` : task
  const checked = entities.length
    ? entities
        .map(
          (e) =>
            `- ${mark(e.exists)} ${kindLabel(e.kind)}\`${e.value}\`${
              e.exists === null
                ? " — could not be checked"
                : e.exists
                  ? " — exists"
                  : " — missing (see the finding)"
            }`,
        )
        .join("\n")
    : "- (nothing the task names could be checked by reading the repo)"
  const failed = findings.filter((f) => f.tier === "risk")
  const failedLine = failed.length
    ? `\n**${failed.length} premise(s) already failed** — the task names things that do not exist. Resolve those before anything below.\n`
    : ""

  return `# Premise brief — ${title}

The task, verbatim:

> ${task.replace(/\n/g, "\n> ")}

etymd checked what the task names against the repo. What it could NOT check is listed under
"only you can verify"; check those before acting, and if one fails, say so first — everything
else is downstream of it.
${failedLine}
## What the task names, and whether it exists

${checked}

## Premises only you can verify

1. **The named things are the ones MEANT.** A file that exists can still be the wrong file, and a
   script that exists can still not be the one the task has in mind. Confirm each is where the
   behaviour actually lives before touching it.
2. **The mechanism the task assumes is working.** A task shaped like "make X faster / less flaky /
   fresh after Y" assumes X and Y already do what it says. Run them once. If the assumed
   mechanism does not run, the task is downstream of a defect it does not mention.
3. **The state the task assumes holds.** Read it; do not trust the task's description of it.

## If a premise fails

Report it first, in one line: what the task presupposes, and what you found instead. Do not
answer the original task as if the premise held — a wrong problem solved precisely is still the
wrong problem.
`
}
