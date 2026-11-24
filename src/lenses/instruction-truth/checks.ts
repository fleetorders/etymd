import path from "node:path"

import type { Finding, FindingTier } from "../../engine/finding.js"
import type { ProjectFacts } from "../../core/types.js"
import { git, isDirectory, pathExists, readJson, readText } from "../../core/util.js"
import { parseDecisionEntries } from "../state-freshness.js"
import {
  extractCommandClaims,
  extractDecisionRefs,
  extractDocRefs,
  extractPathClaims,
} from "./claims.js"

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
  /** The root plus every workspace package dir — where claims are resolved. */
  bases: string[]
  /**
   * A repo-relative claim resolves in the root, any workspace package, their src/ scripts/, or
   * the directory of the file making the claim (`fromDir`) — a nested instruction file writes
   * references the way an agent reading it resolves them: against its siblings.
   */
  pathResolves(claim: string, fromDir?: string): Promise<boolean>
  /** A pm-plus-name invocation may legitimately run an installed node_modules/.bin binary. */
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
  // STATED RULE, not an accident: existence is judged on the WORKING TREE, never the index. A
  // claim that exists on disk is true even when gitignored — the author wrote against a real
  // checkout, and a machine-local file is unverifiable, not fictional. A gitignored claim that
  // is absent is the check-ignore step in checkTextClaims: skipped and counted, never accused.
  const pathResolves = async (claim: string, fromDir?: string): Promise<boolean> => {
    for (const base of bases) {
      if (await pathExists(path.join(base, claim))) return true
      // Conventional sub-roots instruction prose is written relative to.
      if (await pathExists(path.join(base, "src", claim))) return true
      if (await pathExists(path.join(base, "scripts", claim))) return true
    }
    // Relative to the claiming file's own directory: an instruction file below the root
    // (`.claude/skills/x/SKILL.md` naming `references/kv/`) means its sibling. Only a real
    // repo-relative file carries a directory — labels like `task` reduce to "." and are skipped.
    if (fromDir && fromDir !== "." && (await pathExists(path.join(root, fromDir, claim))))
      return true
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
    bases,
    pathResolves,
    binResolves,
  }
}

/** Skip-class tallies — every class a check declines to accuse is counted, then disclosed. */
export interface ClaimCounters {
  filteredSkipped: number
  tildeSkipped: number
  /** Doc mentions whose own line says the doc deliberately does not exist here — skipped, counted. */
  absenceSkipped: number
  binaryResolved: number
  unverifiableCommands: number
  gitignoredSkipped: number
  prospectiveSkipped: number
  /** Path claims whose every mention sits beside the URL it is fetched from — another tree. */
  fetchedSkipped: number
  placeholderSkipped: number
  /** Decision references naming another record (a fleet-level ledger) — not this repo's. */
  qualifiedRefsSkipped: number
  /** Decision references with no `## D-NNN` ledger to resolve against. */
  unresolvableRefs: number
  /** Path claims whose every mention sits behind a namespace prefix (`app:`) — another repo's. */
  namespacedSkipped: number
  /** Missing paths starting at no directory of this repo — quoted from elsewhere (task only). */
  outsideRepoSkipped: number
  /** Slash-joined file names (`a.ts/b.ts`) — a list of alternatives, not one path. */
  alternativesSkipped: number
  /** Doc mentions that may mean the reader's user-level file, which no repo can see. */
  userLevelDocSkipped: number
  /** Command mentions in a repo with no package manifest at all — they describe other trees. */
  noManifestCommandsSkipped: number
  /**
   * Missing paths written only right after a command-line flag — the flag's value or, after a
   * boolean flag, an operand of the usage line (`node --watch src/x.ts`). The text cannot tell
   * which, so both are skipped: a usage example's input either way, and precision over recall.
   */
  flagValueSkipped: number
}

export function emptyCounters(): ClaimCounters {
  return {
    filteredSkipped: 0,
    tildeSkipped: 0,
    absenceSkipped: 0,
    binaryResolved: 0,
    unverifiableCommands: 0,
    gitignoredSkipped: 0,
    prospectiveSkipped: 0,
    fetchedSkipped: 0,
    placeholderSkipped: 0,
    qualifiedRefsSkipped: 0,
    unresolvableRefs: 0,
    namespacedSkipped: 0,
    outsideRepoSkipped: 0,
    alternativesSkipped: 0,
    userLevelDocSkipped: 0,
    noManifestCommandsSkipped: 0,
    flagValueSkipped: 0,
  }
}

/**
 * One thing a check looked for, and what it found. `null` = could not be checked from the repo
 * (counted and disclosed), never a guess. The honest-coverage half of a report: what was
 * examined, not only what failed.
 */
export interface ExaminedClaim {
  kind: "script" | "path" | "doc" | "decision"
  value: string
  exists: boolean | null
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
  /**
   * Directories a missing path may start from and still be plausibly repo-relative — the root,
   * workspace packages, and their src/ scripts/; for source comments also the directories at and
   * above the commenting file, per file. Supplied by the task surface (`etymd premise`) and the
   * comment lens: a task or comment quoting a path from ANOTHER tree starts where no directory of
   * this repo does, and its absence here proves nothing. Instruction files keep the stricter
   * reading — their references are written against this repo.
   */
  rootedFirstSegments?: ReadonlySet<string>
  /**
   * Read namespace-prefixed path mentions (`app: `src/x.ts``) as another repo's tree — the task
   * surface only; instruction files keep every backticked span as a claim of this repo.
   */
  treatNamespacedPrefixes?: boolean
  /**
   * Source comments only. A comment is written from where its file sits: in a nested package
   * (`tools/site/src/build.mjs` saying `src/build.mjs`) the path is relative to that package,
   * whether or not a workspace manifest declares it. With this set, a claim also resolves from
   * every directory above the claiming file, and a JavaScript import specifier resolves to its
   * TypeScript source (`./logs.js` written in a file whose sibling is `logs.ts`).
   */
  sourceRelative?: boolean
  /**
   * Source comments only. In a repo with no package manifest anywhere, a package-manager command in a comment
   * cannot name a script of this repo — it describes a command of the trees this code works on.
   * Skipped and counted; instruction files keep the accusation (they tell agents what to run HERE).
   */
  skipCommandsWithoutManifest?: boolean
}

// A non-final segment that ends in a file extension: `order.ts/order.data.ts`, `AGENTS.md/CLAUDE.md`.
// Nothing is inside a file, so the slash joins alternatives. Judged on missing claims only — a
// real `conf.d/x` or `My.app/Contents` resolves before this is ever asked. An extension is one
// to five characters, a letter first (`ts`, `json`, `plist`, `swift`): a longer dotted suffix
// (`.config`, `.template`, `.backup`) names directories and versions as often as file types, so
// `web.config/web.template` is judged as one path — a deliberate cut-off, not an oversight.
const FILE_SEGMENT_RE = /[^./]\.[A-Za-z][A-Za-z0-9]{0,4}$/
async function isAlternativesList(
  claim: string,
  isDir: (prefix: string) => Promise<boolean>,
): Promise<boolean> {
  const segments = claim.replace(/\/$/, "").split("/")
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!FILE_SEGMENT_RE.test(segments[i] as string)) continue
    // A dotted name that is a real directory (`conf.d/`) is a path segment, never a file name:
    // a missing file beneath it stays a finding.
    if (await isDir(segments.slice(0, i + 1).join("/"))) continue
    return true
  }
  return false
}

const TS_FOR_JS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}
// `--out build/report.json`, `--from=staged/2.json`: in a usage line the path is a value the
// caller supplies, shown as an example. Only when EVERY mention of the claim sits behind a flag.
// Whether the flag takes a value is unknowable from text, so an operand after a boolean flag
// (`node --watch src/x.ts`) reads the same way — the stated rule is "right after a flag", and the
// disclosure says so; a dead script named only that way is a missed finding, never a false one.
// The flag may open a quoted span (`` `--out x.json` ``): a quote or backtick before the dashes
// is a boundary exactly like whitespace, or that span's own mention would read as a bare path.
const FLAG_BEFORE_RE = /(?:^|[\s[(|`'"])--?[A-Za-z][A-Za-z0-9-]*(?:=|\s+)[`"']?$/
const PATH_CHAR_RE = /[A-Za-z0-9_./-]/
function isOnlyFlagValue(text: string, claim: string): boolean {
  let at = text.indexOf(claim)
  if (at === -1) return false
  let mentions = 0
  while (at !== -1) {
    // Only a whole path token is a mention: the claim found as the tail or head of a longer
    // path (`backup/src/out/2.json`) is that other path's text, judged under its own claim.
    const before = text[at - 1] ?? ""
    const after = text[at + claim.length] ?? ""
    const whole = !PATH_CHAR_RE.test(before) && !/[A-Za-z0-9_/-]/.test(after)
    if (whole) {
      if (!FLAG_BEFORE_RE.test(text.slice(Math.max(0, at - 80), at))) return false
      mentions += 1
    }
    at = text.indexOf(claim, at + claim.length)
  }
  return mentions > 0
}

/**
 * Does a missing path start somewhere this repo has? In a source comment a leading `./` or `../`
 * is relative to the commenting file, so the reference is about this tree by construction —
 * deleting the directory it names must not reclassify the mention as quoted from another repo.
 * A multi-segment claim without one is judged by the directory it names.
 */
function startsInRepo(claim: string, opts: TextClaimsOptions): boolean {
  const rooted = opts.rootedFirstSegments
  if (!rooted) return true
  if (!opts.sourceRelative) return rooted.has(claim.split("/")[0] ?? claim)
  if (/^\.\.?\//.test(claim)) return true
  const segments = claim.replace(/^(?:\.\.?\/)+/, "").split("/")
  if (segments.length < 2) return true
  return rooted.has(segments[0] as string)
}

/** The TypeScript sources a JavaScript specifier may stand for (ESM imports name the output). */
function sourceSpecifierCandidates(claim: string): string[] {
  const ext = path.extname(claim)
  return (TS_FOR_JS[ext] ?? []).map((ts) => claim.slice(0, -ext.length) + ts)
}

/** Every directory above a repo-relative directory, nearest first, the root (".") excluded. */
function ancestorDirs(fromDir: string): string[] {
  const out: string[] = []
  let dir = fromDir
  while (dir && dir !== "." && dir !== path.dirname(dir)) {
    out.push(dir)
    dir = path.dirname(dir)
  }
  return out
}

export interface TextClaimsResult {
  findings: Finding[]
  disclosures: string[]
  /** Every script and path claim the text made, found or not. */
  examined: ExaminedClaim[]
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
  const examined: ExaminedClaim[] = []
  const subject = opts.subject ?? file.path

  // Command claims: a script the text tells agents to run must exist somewhere real.
  const { scripts: claimed, filteredSkipped } = extractCommandClaims(file.text, env.knownScripts)
  counters.filteredSkipped += filteredSkipped
  for (const [script, raw] of claimed) {
    if (opts.skipCommandsWithoutManifest && !env.manifestExists) {
      counters.noManifestCommandsSkipped += 1
      examined.push({ kind: "script", value: script, exists: null })
      continue
    }
    if (env.knownScripts.has(script)) {
      examined.push({ kind: "script", value: script, exists: true })
      continue
    }
    if (await env.binResolves(script)) {
      counters.binaryResolved += 1
      examined.push({ kind: "script", value: script, exists: true })
      continue
    }
    if (!env.nodeModulesInstalled && env.manifestExists) {
      counters.unverifiableCommands += 1
      examined.push({ kind: "script", value: script, exists: null })
      continue
    }
    examined.push({ kind: "script", value: script, exists: false })
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
  const { paths, dirs, prospective, fetched, placeholder, namespaced } = extractPathClaims(
    file.text,
    { namespaces: opts.treatNamespacedPrefixes },
  )
  counters.prospectiveSkipped += prospective.length
  counters.fetchedSkipped += fetched.length
  counters.placeholderSkipped += placeholder.length
  counters.namespacedSkipped += namespaced.length
  // A label like `task` has no directory; a real file's dir is a resolution base (see
  // buildTruthEnv).
  const fromDir = path.dirname(file.path)
  const unresolved: string[] = []
  const resolvesFromSource = async (claim: string): Promise<boolean> => {
    if (!opts.sourceRelative) return false
    const candidates = [claim, ...sourceSpecifierCandidates(claim)]
    for (const candidate of candidates) {
      if (candidate !== claim && (await env.pathResolves(candidate, fromDir))) return true
      for (const dir of ancestorDirs(fromDir)) {
        if (await pathExists(path.join(env.root, dir, candidate))) return true
      }
    }
    return false
  }
  for (const claim of paths) {
    if ((await env.pathResolves(claim, fromDir)) || (await resolvesFromSource(claim)))
      examined.push({ kind: "path", value: claim, exists: true })
    else unresolved.push(claim)
  }
  // A document that names a directory and then writes paths relative to it is ordinary prose,
  // not a stale reference — and the reference usually repeats the named directory's own last
  // segment (`run state is `x/v3/` … `v3/CHECKPOINT.json``), making it relative to the named
  // directory's PARENT. Directory claims in the SAME text that themselves resolve are candidate
  // bases, tried there and under the claiming file's dir; a claim that exists under one is
  // verified, never accused. A false resolution hides a finding; a false accusation destroys
  // trust — this tool is built to prefer the first error.
  const proseBases = new Set<string>()
  for (const dirClaim of dirs) {
    if (await env.pathResolves(dirClaim, fromDir)) {
      proseBases.add(dirClaim)
      proseBases.add(path.dirname(dirClaim))
    }
  }
  const missing: string[] = []
  for (const claim of unresolved) {
    let anchored = false
    for (const base of proseBases) {
      if (await pathExists(path.join(env.root, base, claim))) anchored = true
      else if (fromDir !== "." && (await pathExists(path.join(env.root, fromDir, base, claim))))
        anchored = true
      if (anchored) break
    }
    if (anchored) examined.push({ kind: "path", value: claim, exists: true })
    else missing.push(claim)
  }
  // A gitignored claim (`.env`, local caches) is machine-local by design: absence in THIS
  // checkout does not make the text false — unverifiable, so skipped, never accused.
  // check-ignore exits non-zero when nothing matches; git() maps that to null.
  const ignoredOut = missing.length ? await git(env.root, ["check-ignore", ...missing]) : null
  const gitignored = new Set((ignoredOut ?? "").split("\n").filter(Boolean))
  // A dir-only ignore pattern (`assets/cards/`) matches the bare token only when the
  // directory exists on disk — git decides "is a directory" by existence — so fresh
  // checkouts miss the skip above. The slash-terminated probe matches regardless of disk
  // state (git echoes it slash-terminated, trimmed back to the claim). Miss path only.
  const unproven = missing.filter((claim) => !gitignored.has(claim))
  if (unproven.length) {
    const dirOut = await git(env.root, ["check-ignore", ...unproven.map((claim) => `${claim}/`)])
    for (const line of (dirOut ?? "").split("\n").filter(Boolean))
      gitignored.add(line.replace(/\/$/, ""))
  }
  // A dotted segment continues the alternatives walk only when its prefix names a real DIRECTORY:
  // a claim like `src/a.ts/b.ts`, whose dotted prefix names a file nothing sits inside, is the
  // alternatives list it shapes — and the search looks everywhere the claim itself could resolve (the bases
  // and their src/ scripts/ sub-roots, the claiming file's directory, and for source comments
  // every directory above it), so a nested `conf.d/` protects its missing file as firmly as a
  // root one. The old existence probe passed files and missed nested packages on both counts.
  const dirProbes: string[] = []
  for (const base of env.bases)
    dirProbes.push(base, path.join(base, "src"), path.join(base, "scripts"))
  if (fromDir && fromDir !== ".") {
    dirProbes.push(path.join(env.root, fromDir))
    if (opts.sourceRelative)
      for (const dir of ancestorDirs(fromDir)) dirProbes.push(path.join(env.root, dir))
  }
  const prefixIsDir = async (prefix: string): Promise<boolean> => {
    for (const probe of dirProbes) if (await isDirectory(path.join(probe, prefix))) return true
    return false
  }
  let pathFindings = 0
  for (const claim of missing) {
    if (await isAlternativesList(claim, prefixIsDir)) {
      counters.alternativesSkipped += 1
      examined.push({ kind: "path", value: claim, exists: null })
      continue
    }
    if (opts.sourceRelative && isOnlyFlagValue(file.text, claim)) {
      counters.flagValueSkipped += 1
      examined.push({ kind: "path", value: claim, exists: null })
      continue
    }
    // Outside this repo (task surface and source comments): a path that starts at no directory the repo has
    // is quoted from elsewhere, and "missing here" would be a false accusation.
    if (opts.rootedFirstSegments && !startsInRepo(claim, opts)) {
      counters.outsideRepoSkipped += 1
      examined.push({ kind: "path", value: claim, exists: null })
      continue
    }
    if (gitignored.has(claim)) {
      counters.gitignoredSkipped += 1
      examined.push({ kind: "path", value: claim, exists: null })
      continue
    }
    examined.push({ kind: "path", value: claim, exists: false })
    // Findings are capped, the examined list is not — the brief still names every miss.
    if (pathFindings >= opts.maxPathFindings) {
      if (pathFindings === opts.maxPathFindings) {
        disclosures.push(
          `${file.path}: more than ${opts.maxPathFindings} missing-path claims — truncated.`,
        )
        pathFindings += 1
      }
      continue
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

  return { findings, disclosures, examined }
}

export interface RefsResult {
  findings: Finding[]
  examined: ExaminedClaim[]
}

// Docs a coding agent also reads from the user's own config directory (`~/.claude/CLAUDE.md`,
// `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`). Kept in step with KNOWN_DOC_REFS in claims.ts:
// every doc name extracted there with a config-directory twin belongs here too, or a bare
// mention of it is accused on the very "may mean the reader's own file" reasoning this set
// exists to exempt. A source comment naming one bare may mean that file, which no repo carries —
// unverifiable from here. Instruction files keep the check: there the name is a pointer an agent
// follows inside this repo.
const USER_LEVEL_DOCS = new Set(["CLAUDE.md", "AGENTS.md", "GEMINI.md"])

/** Cross-references to well-known docs (AGENTS.md, CLAUDE.md, …) must resolve to real files. */
export async function checkDocRefs(
  env: TruthEnv,
  file: ClaimText,
  lensId: string,
  counters: ClaimCounters,
  subject = file.path,
  opts: { userLevelUnverifiable?: boolean } = {},
): Promise<RefsResult> {
  const findings: Finding[] = []
  const examined: ExaminedClaim[] = []
  const { refs, tildeSkipped, absenceSkipped } = extractDocRefs(file.text)
  counters.tildeSkipped += tildeSkipped
  counters.absenceSkipped += absenceSkipped
  for (const ref of refs) {
    const exists = await pathExists(path.join(env.root, ref))
    if (!exists && opts.userLevelUnverifiable && USER_LEVEL_DOCS.has(ref)) {
      counters.userLevelDocSkipped += 1
      examined.push({ kind: "doc", value: ref, exists: null })
      continue
    }
    examined.push({ kind: "doc", value: ref, exists })
    if (exists) continue
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
  return { findings, examined }
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

export interface DecisionRefsOptions {
  lensId: string
  /** How the text is named in a claim sentence — a file path, or "The task". */
  subject?: string
  why?: string
  action?: string
}

/**
 * `D-NNN` references in one text, resolved against the repo's own decision record. A citation
 * the record cannot back is stale in a way age cannot reveal. Qualified refs (another record's)
 * and refs with no ledger to resolve against are counted, never accused.
 */
export function checkDecisionRefs(
  file: ClaimText,
  ledger: DecisionLedger,
  opts: DecisionRefsOptions,
  counters: ClaimCounters,
): RefsResult {
  const findings: Finding[] = []
  const examined: ExaminedClaim[] = []
  const subject = opts.subject ?? file.path
  const { refs, qualifiedSkipped } = extractDecisionRefs(file.text)
  counters.qualifiedRefsSkipped += qualifiedSkipped
  if (!refs.size) return { findings, examined }
  if (!ledger.ids) {
    counters.unresolvableRefs += refs.size
    for (const asWritten of refs.values()) {
      examined.push({ kind: "decision", value: asWritten, exists: null })
    }
    return { findings, examined }
  }
  for (const [num, asWritten] of refs) {
    const exists = ledger.ids.has(num)
    examined.push({ kind: "decision", value: asWritten, exists })
    if (exists) continue
    findings.push({
      lens: opts.lensId,
      id: `${opts.lensId}/dead-decision-ref:${file.path}:${asWritten}`,
      tier: "gap",
      claim: `${subject} cites ${asWritten} — no such entry exists in ${ledger.sources.join(", ")}`,
      evidence: [file.path, `${ledger.sources.join(", ")}: no ${asWritten} entry`],
      why:
        opts.why ??
        "A state doc is read as ground truth on return; a citation the decision record cannot back sends readers to a ruling that was never written.",
      action: opts.action ?? "Fix the reference — or record the missing decision.",
      effort: "S",
      confidence: "medium",
    })
  }
  return { findings, examined }
}
