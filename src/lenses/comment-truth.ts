import path from "node:path"

import type { Finding, Lens, LensContext, LensReport } from "../engine/finding.js"
import { listRootedDirs, promoteBareTokens } from "../engine/premise.js"
import { git, pathExists, readJson, readText } from "../core/util.js"
import {
  buildTruthEnv,
  checkDecisionRefs,
  checkDocRefs,
  checkTextClaims,
  emptyCounters,
  loadDecisionLedger,
  type TruthEnv,
} from "./instruction-truth/checks.js"
import {
  isExampleMention,
  isPackagedMention,
  leadWord,
  mentionsOf,
} from "./instruction-truth/comment-context.js"
import {
  commentStyleFor,
  extractComments,
  MIXED_LANGUAGE_EXTS,
} from "./instruction-truth/comments.js"
import { extractPathClaims } from "./instruction-truth/claims.js"

// The comment-truth lens: the four claim checkers (script, path, doc, decision) over source-code
// COMMENTS, not just instruction files — D-013. A comment is a written rule that happens to
// live in a `.ts` file; it rots the same way an AGENTS.md line does, and nothing else in the repo
// checks it. The checks themselves are the shared ones (checks.ts) with the premise surface's
// prose promotion, so a third copy of the precision rules can never drift in beside them.

const LENS_ID = "comment-truth"
const MAX_FILES = 2000
const MAX_FILE_BYTES = 1_000_000
const MAX_PATH_FINDINGS_PER_FILE = 10
const MAX_EVIDENCE_LINES = 3
// A directory holding one of these is a package: paths written inside it start at its root.
const PACKAGE_MANIFEST_RE = /(?:^|\/)(?:package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/

// Directories and basenames whose comments are about fixtures and vendored code, never about this
// repo's own surface — the paths they name are deliberately nonexistent. Skipped, counted, and
// disclosed; also reported as outOfScope so the ledger holds any tracked finding inside them open
// (unexamined is not fixed).
const SKIP_DIR_RE =
  /(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|mocks|__mocks__|testdata|vendor|third-party|third_party|external)\//i
const SKIP_BASENAME_RE = /\.(?:test|spec|min)\.[a-z0-9]+$/i

function skippedLens(reason: string): LensReport {
  return {
    lens: LENS_ID,
    version: "1",
    title: "Source comment truth",
    kind: "truth",
    status: "skipped",
    reason,
    disclosures: [],
    findings: [],
  }
}

/**
 * Wrap a resolution probe with a per-run cache: the same claim repeats across many comments of one
 * repo (one dead decision can be cited from hundreds of comments), and each miss costs a filesystem
 * walk over every workspace base.
 */
function cached<K extends string>(fn: (k: K) => Promise<boolean>): (k: K) => Promise<boolean> {
  const memo = new Map<string, Promise<boolean>>()
  return (k) => {
    let hit = memo.get(k)
    if (!hit) {
      hit = fn(k)
      memo.set(k, hit)
    }
    return hit
  }
}

/**
 * The path probe caches on (claim, fromDir), never on the claim alone: TruthEnv's `fromDir` is an
 * additional resolution base (the claiming file's siblings), so the same string asked from two
 * directories is two different questions. A one-argument wrapper silently dropped the directory —
 * relative claims lost their sibling semantics, and the first directory to probe a repeated string
 * decided the answer every other directory inherited.
 */
function cachedPathResolve(
  fn: (claim: string, fromDir?: string) => Promise<boolean>,
): (claim: string, fromDir?: string) => Promise<boolean> {
  const memo = new Map<string, Promise<boolean>>()
  return (claim, fromDir) => {
    // The underlying probe skips `fromDir === "."` itself, so it shares the no-directory key.
    const key = fromDir && fromDir !== "." ? `${fromDir}\0${claim}` : `\0${claim}`
    let hit = memo.get(key)
    if (!hit) {
      hit = fn(claim, fromDir)
      memo.set(key, hit)
    }
    return hit
  }
}

export const commentTruthLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Source comment truth",
  kind: "truth",
  async run(ctx: LensContext): Promise<LensReport> {
    const { root, facts } = ctx
    const siblingNames = new Set(ctx.siblingNames ?? [])
    if (!facts.git.isRepo) {
      return skippedLens("not a git repository — tracked source files cannot be enumerated")
    }
    const listed = await git(root, ["ls-files", "-z"])
    // Empty output is zero tracked files (a freshly materialised tree can honestly have none —
    // that is "checked nothing", not a failure); only null means git itself did not answer.
    if (listed === null)
      return skippedLens("git ls-files failed — tracked source files cannot be enumerated")

    const tracked = listed.split("\0").filter(Boolean)
    const targets: string[] = []
    const outOfScope: string[] = []
    let skippedByPath = 0
    let mixedLanguage = 0
    for (const rel of tracked) {
      const ext = rel.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ""
      if (MIXED_LANGUAGE_EXTS.has(ext)) mixedLanguage += 1
      if (SKIP_BASENAME_RE.test(rel) || SKIP_DIR_RE.test(rel)) {
        skippedByPath += 1
        outOfScope.push(rel)
        continue
      }
      if (commentStyleFor(rel)) targets.push(rel)
    }
    const truncated = targets.length > MAX_FILES
    const scanTargets = targets.slice(0, MAX_FILES)
    // Files past the cap were never examined: out of scope, so the ledger keeps their findings open.
    outOfScope.push(...targets.slice(MAX_FILES))

    const findings: Finding[] = []
    const disclosures: string[] = []
    const counters = emptyCounters()
    const promotionSkips = {
      bareInvocations: 0,
      proseScripts: 0,
      hostnameLike: 0,
      unrootedDirs: 0,
      namespaced: 0,
    }

    const env = await buildTruthEnv(root, facts)
    const pathResolves = cachedPathResolve(env.pathResolves)
    const binResolves = cached(env.binResolves)
    // Nested manifests count whether or not a workspace declares them (a `server/` with its own
    // manifest beside an app), and their scripts are POOLED into one flat set, not scoped to the
    // package the commenting file sits in: a root comment naming `pnpm dev` defined only in
    // `server/` is accepted. That is the monorepo rule instruction files use, kept on purpose —
    // comments name a sibling package's script bare often enough that a per-package reading
    // would accuse true text, and a false accusation costs more than a missed one. Manifests
    // inside the skipped fixture/vendor directories are the exception, on the same line that
    // keeps their comments out of the scan: their scripts describe the fixtures, never this
    // repo's own commands.
    const knownScripts = new Set(env.knownScripts)
    const nestedManifests = tracked.filter(
      (rel) =>
        path.basename(rel) === "package.json" &&
        !SKIP_DIR_RE.test(rel) &&
        !SKIP_BASENAME_RE.test(rel),
    )
    for (const rel of nestedManifests) {
      const pkgJson = await readJson<{ scripts?: Record<string, string> }>(path.join(root, rel))
      for (const key of Object.keys(pkgJson?.scripts ?? {})) knownScripts.add(key)
    }
    const scopedEnv: TruthEnv = {
      ...env,
      knownScripts,
      manifestExists: env.manifestExists || nestedManifests.length > 0,
      pathResolves,
      binResolves,
    }
    const ledger = await loadDecisionLedger(root, facts)
    // Where a missing path may start and still be about this repo: a directory found where the
    // comment's paths resolve — the root, a workspace package and their src/ scripts/
    // (listRootedDirs), or the commenting file's own directory and every directory above it (a
    // comment is written from where its file sits, so a nested package's comment names paths
    // relative to that package).
    // Per file, never repo-wide: almost every repo carries `src`, `test` or `docs` somewhere, so
    // an any-depth set took nearly every path quoted from another tree as this repo's, and a name
    // living only in an unrelated subtree (an `ios/` inside a mobile package) vouched for a
    // comment in `server/`. A path starting anywhere else is quoted from another tree — a sibling
    // repo, an upstream project, a device — and its absence here proves nothing.
    const baseRooted = await listRootedDirs(env)
    const childDirs = new Map<string, Set<string>>()
    for (const rel of tracked) {
      const segments = rel.split("/")
      for (let i = 0; i < segments.length - 1; i += 1) {
        const parent = segments.slice(0, i).join("/") || "."
        let names = childDirs.get(parent)
        if (!names) childDirs.set(parent, (names = new Set()))
        names.add(segments[i] as string)
      }
    }
    const rootedByDir = new Map<string, ReadonlySet<string>>()
    const rootedFor = (rel: string): ReadonlySet<string> => {
      const fromDir = path.posix.dirname(rel)
      const hit = rootedByDir.get(fromDir)
      if (hit) return hit
      const rooted = new Set([...baseRooted, ...(childDirs.get(".") ?? [])])
      for (let dir = fromDir; dir !== "."; dir = path.posix.dirname(dir))
        for (const name of childDirs.get(dir) ?? []) rooted.add(name)
      rootedByDir.set(fromDir, rooted)
      return rooted
    }

    // What a comment says about a missing path decides whether it is a stale reference at all
    // (comment-context.ts); and a comment the fork inherited from its upstream is upstream's to
    // fix. Both are decided per comment, on findings only, so a clean file costs nothing extra.
    const contextSkips = { example: 0, packaged: 0, sibling: 0, wrapped: 0, nested: 0, upstream: 0 }
    // Per (file, claim): the skip its mentions read as, and whether any mention kept the
    // finding alive. The counts are taken at the end, over ids that never survived — a claim
    // read as an example in one comment and plainly in another is flagged, and must not also
    // be counted "skipped, not flagged" beside its own finding.
    const skippedIds = new Map<string, keyof typeof contextSkips>()
    const keptIds = new Set<string>()
    // A missing path that exists under a nested package's own directory was written relative to
    // that package, by a file that does not sit in it (a root script naming a package's file).
    const packageDirs = [
      ...new Set(
        tracked
          .filter((rel) => PACKAGE_MANIFEST_RE.test(rel))
          .map((rel) => path.posix.dirname(rel))
          .filter((d) => d !== "."),
      ),
    ]
    const isInNestedPackage = cachedPathResolve(async (claim: string, rel?: string) => {
      if (!rel || claim.startsWith(".")) return false // dot-relative: about the commenting file's own directory
      const bare = claim.replace(/\/+$/, "")
      if (!bare.includes("/")) return false
      // Asked of the working tree, like every other path check: a file deleted but still in
      // the index is gone. Scoped to the commenting file, the same relation sourceRelative
      // resolves from: only a package the file sits inside may lend its frame. A package an
      // unrelated subtree carries must not vouch for a root script's stale path — in any
      // monorepo some package then holds a file at the same relative spot, and a deleted
      // root-level `src/...` path could no longer be caught anywhere.
      for (const d of packageDirs)
        if (rel.startsWith(`${d}/`) && (await pathExists(path.join(root, d, bare)))) return true
      return false
    })
    let upstreamRemote = ctx.upstreamRemote
    if (upstreamRemote) {
      const fetched = await git(root, [
        "for-each-ref",
        "--count=1",
        `refs/remotes/${upstreamRemote}`,
      ])
      if (!fetched) {
        disclosures.push(
          `upstream remote \`${upstreamRemote}\` has no fetched refs — comments inherited from it could not be told apart and were checked like the rest.`,
        )
        upstreamRemote = undefined
      }
    }
    const upstreamCommit = cached(async (sha: string) => {
      if (/^0+$/.test(sha)) return false // not committed yet: this checkout's own work
      // Empty output: nothing of this commit lies outside the upstream remote's refs.
      return (
        (await git(root, ["rev-list", "-n", "1", sha, "--not", `--remotes=${upstreamRemote}`])) ===
        ""
      )
    })
    const writtenUpstream = async (rel: string, first: number, last: number): Promise<boolean> => {
      if (!upstreamRemote) return false
      const blame = await git(root, ["blame", "--porcelain", "-L", `${first},${last}`, "--", rel])
      if (!blame) return false
      const shas = new Set(
        blame
          .split("\n")
          .map((line) => /^([0-9a-f]{40}) \d+ \d+/.exec(line)?.[1])
          .filter((sha): sha is string => Boolean(sha)),
      )
      if (!shas.size) return false
      for (const sha of shas) if (!(await upstreamCommit(sha))) return false
      return true
    }
    const stalePathPrefix = `${LENS_ID}/stale-path:`
    /** Why a missing path in this comment is not a stale reference, or null when it is one. */
    const contextSkip = async (
      span: { text: string },
      rel: string,
      finding: Finding,
      carry: string,
      continuesOnNextLine: boolean,
    ): Promise<keyof typeof contextSkips | null> => {
      // The word rules decide what any missing PATH in this comment means, and a dangling doc
      // reference is a missing path to the reader — the same mention through the doc-refs
      // checker must read the same way, or a comment that says "a file like docs/decisions.md"
      // drops in the path checker and flags in the doc checker (D-014: dropped only when every
      // mention reads the same way). Decision references cite labels ("D-014"), not paths:
      // the path-shaped rules do not read them.
      const stalePrefix = `${stalePathPrefix}${rel}:`
      const docRefPrefix = `${LENS_ID}/dangling-ref:${rel}:`
      const claim = finding.id.startsWith(stalePrefix)
        ? finding.id.slice(stalePrefix.length)
        : finding.id.startsWith(docRefPrefix)
          ? finding.id.slice(docRefPrefix.length)
          : null
      if (claim === null) return null
      const mentions = mentionsOf(span.text, claim)
      if (!mentions.length) return (await isInNestedPackage(claim, rel)) ? "nested" : null
      if (mentions.every((m) => isExampleMention(m.before, m.after))) return "example"
      if (mentions.every((m) => isPackagedMention(m.before, m.after))) return "packaged"
      if (
        siblingNames.size &&
        mentions.every((m) => siblingNames.has(leadWord(m.before, carry) ?? ""))
      )
        return "sibling"
      // "(cart/checkout/…/auth/" cut by the line wrap inside an open parenthesis: the phrase
      // continues on the next line, so the token is not the whole of what was written.
      const cutByWrap = (m: { before: string; after: string }) =>
        continuesOnNextLine &&
        m.after.trim() === "" &&
        m.before.lastIndexOf("(") > m.before.lastIndexOf(")") &&
        span.text.trimEnd().endsWith("/")
      if (mentions.every(cutByWrap)) return "wrapped"
      if (await isInNestedPackage(claim, rel)) return "nested"
      return null
    }

    let filesWithComments = 0
    let commentCount = 0
    let unreadable = 0
    for (const rel of scanTargets) {
      const text = await readText(path.join(root, rel))
      if (text === null) {
        // A tracked file that cannot be read is coverage loss, not absence: held out of scope so
        // the ledger keeps any tracked finding inside it open (unexamined is not fixed), and
        // disclosed — never silently dropped.
        unreadable += 1
        outOfScope.push(rel)
        continue
      }
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
        outOfScope.push(rel)
        continue
      }
      const style = commentStyleFor(rel)
      if (!style) continue
      const spans = extractComments(text, style)
      if (!spans.length) continue
      filesWithComments += 1
      const rootedDirs = rootedFor(rel)

      // One finding per (file, claim): the first occurrence names the line, later ones append
      // theirs to the evidence (capped) — 600 comments citing one deleted decision are one
      // finding with three example lines, not 600 findings.
      const byId = new Map<string, Finding>()
      const addAll = (fresh: Finding[]) => {
        for (const f of fresh) {
          const prev = byId.get(f.id)
          if (!prev) {
            byId.set(f.id, f)
            continue
          }
          if (prev.evidence.length < MAX_EVIDENCE_LINES) {
            const line = f.claim.match(/^(\S+:\d+)/)?.[1]
            if (line && !prev.evidence.includes(line)) prev.evidence.push(line)
          }
        }
      }

      let previous: { text: string; line: number } | undefined
      for (let i = 0; i < spans.length; i += 1) {
        const span = spans[i] as { text: string; line: number }
        commentCount += 1
        const subject = `${rel}:${span.line}`
        const lastLine = span.line + span.text.split("\n").length - 1
        // The previous comment's tail counts as this one's lead-in only when it is the line
        // directly above — one sentence wrapped across two line comments.
        const carry = previous && previous.line === span.line - 1 ? previous.text : ""
        previous = { text: span.text, line: lastLine }
        // A slash-ended phrase cut by a wrap continues only on the comment line directly
        // below: with no such line the comment simply ends mid-phrase, and "the phrase
        // continues on the next line" would be a disclosure the text contradicts.
        const nextSpan = spans[i + 1] as { text: string; line: number } | undefined
        const continuesOnNextLine = nextSpan !== undefined && nextSpan.line === lastLine + 1
        let inherited: boolean | undefined
        const keep = async (fresh: Finding[]): Promise<Finding[]> => {
          const kept: Finding[] = []
          for (const f of fresh) {
            const why = await contextSkip(span, rel, f, carry, continuesOnNextLine)
            if (why) {
              skippedIds.set(f.id, why)
              continue
            }
            inherited ??= await writtenUpstream(rel, span.line, lastLine)
            if (inherited) {
              skippedIds.set(f.id, "upstream")
              continue
            }
            kept.push(f)
            keptIds.add(f.id)
          }
          return kept
        }
        const promoted = promoteBareTokens(span.text, { rootedDirs, knownScripts })
        for (const key of Object.keys(promotionSkips) as (keyof typeof promotionSkips)[]) {
          promotionSkips[key] += promoted.skips[key]
        }
        // A comment whose own claims resolve under the nested package its file sits in writes
        // from that package's frame. Their first segment roots this comment's other claims too:
        // without it the strict per-file rooting above would read the package's own `src/...`
        // mentions as quoted from another tree, and the nested-package skip in contextSkip
        // would never be reached to sort the present from the absent. Only a claim that IS
        // there anchors — a directory name an unrelated subtree merely carries does not.
        let rootedHere = rootedDirs
        if (packageDirs.length) {
          const spanClaims = extractPathClaims(promoted.text)
          const anchored = new Set<string>()
          for (const claim of [...spanClaims.paths, ...spanClaims.dirs])
            if (await isInNestedPackage(claim, rel)) anchored.add(claim.split("/")[0] ?? claim)
          if (anchored.size) rootedHere = new Set([...rootedDirs, ...anchored])
        }
        const file = { path: rel, text: promoted.text }
        const claims = await checkTextClaims(
          scopedEnv,
          file,
          {
            lensId: LENS_ID,
            subject,
            missingPathTier: "gap",
            // No shared cap here: the cap belongs after the comment-context skips below,
            // or twelve example paths and one stale one would truncate on the examples and
            // lose the only line worth reading.
            maxPathFindings: Number.POSITIVE_INFINITY,
            rootedFirstSegments: rootedHere,
            sourceRelative: true,
            skipCommandsWithoutManifest: true,
            whyCommand:
              "A comment naming a dead command misleads every maintainer and agent who reads the code — the check it describes is silently skipped.",
            actionCommand:
              "Update the comment to the current script, or delete it with the code it explained.",
            whyPath:
              "Comments are the map maintainers and agents navigate source by; a path that no longer exists sends every reader to the wrong place.",
            actionPath: "Point the comment at where the code actually lives, or delete it.",
          },
          counters,
        )
        addAll(await keep(claims.findings))
        disclosures.push(...claims.disclosures)
        addAll(
          await keep(
            (
              await checkDocRefs(scopedEnv, file, LENS_ID, counters, subject, {
                userLevelUnverifiable: true,
              })
            ).findings,
          ),
        )
        addAll(
          await keep(
            checkDecisionRefs(
              file,
              ledger,
              {
                lensId: LENS_ID,
                subject,
                why: "The comment cites a ruling the decision record cannot back — a reader looking for the reasoning finds nothing.",
                action: "Fix the reference, or record the decision it meant to cite.",
              },
              counters,
            ).findings,
          ),
        )
      }
      // The cap, taken after the skips: what it drops is disclosed — the examined list is
      // not the findings list.
      const keptFindings = [...byId.values()]
      if (keptFindings.length > MAX_PATH_FINDINGS_PER_FILE) {
        disclosures.push(
          `${rel}: more than ${MAX_PATH_FINDINGS_PER_FILE} stale-path findings survived the comment-context skips — truncated.`,
        )
        keptFindings.length = MAX_PATH_FINDINGS_PER_FILE
      }
      findings.push(...keptFindings)
    }

    // Honest coverage — every class not checked is named, never silently dropped.
    disclosures.push(
      `Checked ${commentCount} comment(s) across ${filesWithComments} tracked source file(s); command, path, doc-reference, and decision-reference claims verified with the same rules and skip classes as instruction files.`,
    )
    if (skippedByPath) {
      disclosures.push(
        `${skippedByPath} test/fixture/vendor file(s) skipped — their comments describe fixtures and third-party code whose paths are deliberately local to them; never flagged, held out of scope.`,
      )
    }
    if (truncated) {
      disclosures.push(
        `Source scan truncated at ${MAX_FILES} file(s) — ${targets.length - MAX_FILES} more not examined.`,
      )
    }
    if (unreadable) {
      disclosures.push(
        `${unreadable} tracked source file(s) could not be read — held out of scope, their comments not examined.`,
      )
    }
    if (mixedLanguage) {
      disclosures.push(
        `${mixedLanguage} mixed-language file(s) (.vue/.svelte/.astro) not scanned — no single comment grammar covers them.`,
      )
    }
    if (counters.unverifiableCommands) {
      disclosures.push(
        `node_modules is not installed — ${counters.unverifiableCommands} command claim(s) in comments matching no package script could not be checked against installed binaries; skipped, not flagged.`,
      )
    }
    if (counters.binaryResolved) {
      disclosures.push(
        `${counters.binaryResolved} command claim(s) in comments are installed binaries (node_modules/.bin), not package scripts — treated as true.`,
      )
    }
    if (counters.gitignoredSkipped) {
      disclosures.push(
        `${counters.gitignoredSkipped} missing path claim(s) in comments are gitignored (machine-local) — existence is not verifiable from the repo; skipped, not flagged.`,
      )
    }
    if (counters.prospectiveSkipped) {
      disclosures.push(
        `${counters.prospectiveSkipped} path claim(s) sit in create-this prose (the comment anticipates generating them) — forward-looking, not stale; skipped, not flagged.`,
      )
    }
    if (counters.placeholderSkipped) {
      disclosures.push(
        `${counters.placeholderSkipped} path claim(s) in comments are naming stand-ins rather than real references; skipped, not flagged.`,
      )
    }
    if (counters.tildeSkipped) {
      disclosures.push(
        `${counters.tildeSkipped} well-known doc mention(s) in comments sit inside \`~/\` home paths — machine-global files, not this repo's; skipped, not flagged.`,
      )
    }
    if (counters.qualifiedRefsSkipped) {
      disclosures.push(
        `${counters.qualifiedRefsSkipped} decision reference(s) in comments name another record (e.g. a fleet-level ledger) — not claims about this repo's decisions; skipped, not flagged.`,
      )
    }
    if (counters.unresolvableRefs) {
      disclosures.push(
        `${counters.unresolvableRefs} decision reference(s) in comments could not be resolved — no decisions file with \`## D-NNN\` entries; skipped, not flagged.`,
      )
    }
    // The three below are counted by the same shared checks the instruction lens runs; comment
    // prose reaches them just as instruction files do, so they are disclosed here too — a skip
    // class that is counted and never named is a silent coverage hole.
    if (counters.filteredSkipped) {
      disclosures.push(
        `${counters.filteredSkipped} command mention(s) in comments were workspace-filtered before resolution — not read as script claims; skipped, not flagged.`,
      )
    }
    if (counters.fetchedSkipped) {
      disclosures.push(
        `${counters.fetchedSkipped} path claim(s) in comments sit beside the URL they are fetched from — another tree's files, unverifiable here; skipped, not flagged.`,
      )
    }
    if (counters.absenceSkipped) {
      disclosures.push(
        `${counters.absenceSkipped} well-known doc mention(s) in comments name the doc only to say it deliberately does not exist here (create-this or absence prose) — skipped, not flagged.`,
      )
    }
    if (counters.outsideRepoSkipped) {
      disclosures.push(
        `${counters.outsideRepoSkipped} missing path(s) in comments start at no directory found where the comment's paths resolve (the root, a workspace package, their src/ scripts/, or a directory at or above the commenting file) — quoted from another tree; skipped, not flagged.`,
      )
    }
    if (counters.alternativesSkipped) {
      disclosures.push(
        `${counters.alternativesSkipped} slash-joined file name(s) in comments (\`a.ts/b.ts\`) read as a list of alternatives, not one path; skipped.`,
      )
    }
    if (counters.flagValueSkipped) {
      disclosures.push(
        `${counters.flagValueSkipped} missing path(s) in comments appear only right after a command-line flag (\`--out build/x.json\`, \`node --watch src/x.ts\`) — the flag's value or a usage line's operand, an example's input either way; skipped, not flagged.`,
      )
    }
    if (counters.userLevelDocSkipped) {
      disclosures.push(
        `${counters.userLevelDocSkipped} bare mention(s) of CLAUDE.md / AGENTS.md / GEMINI.md in comments have no file here and may mean the reader's user-level file — unverifiable from the repo; skipped, not flagged.`,
      )
    }
    if (counters.noManifestCommandsSkipped) {
      disclosures.push(
        `${counters.noManifestCommandsSkipped} package-manager command(s) in comments were not checked — this repo has no package manifest, so they describe commands of other trees; skipped.`,
      )
    }
    for (const [id, why] of skippedIds) if (!keptIds.has(id)) contextSkips[why] += 1
    if (contextSkips.example) {
      disclosures.push(
        `${contextSkips.example} missing path(s) in comments are introduced as examples ("a path like …", "e.g. …") — shapes, not references; skipped, not flagged.`,
      )
    }
    if (contextSkips.packaged) {
      disclosures.push(
        `${contextSkips.packaged} missing path(s) in comments are placed inside a built artifact ("… out of the APK") — laid out by the build, not by this tree; skipped, not flagged.`,
      )
    }
    if (contextSkips.sibling) {
      disclosures.push(
        `${contextSkips.sibling} missing path(s) in comments directly follow the name of another repository in this fleet — that repository's paths, not this one's; skipped, not flagged.`,
      )
    }
    // The sibling names arrive only from the fleet sweep (engine/fleet.ts), so a local audit —
    // the pre-push gate among them — runs without the class at all. Same tree, same ledger,
    // different verdict depending on who asks: the asymmetry is kept (duplicating the names
    // into every consumer's config would drift) and disclosed where it exists.
    if (!siblingNames.size && filesWithComments) {
      disclosures.push(
        "no sibling repositories are known to this run (the fleet sweep supplies their names) — the sibling-name skip could not be applied, so a path written after another repository's name may be flagged here that the sweep would skip.",
      )
    }
    if (contextSkips.wrapped) {
      disclosures.push(
        `${contextSkips.wrapped} slash-ended phrase(s) in comments are cut by a line wrap inside an open parenthesis — the phrase continues on the next line; skipped, not flagged.`,
      )
    }
    if (contextSkips.nested) {
      disclosures.push(
        `${contextSkips.nested} missing path(s) in comments exist under the nested package their commenting file sits in — written relative to that package; treated as true, not flagged.`,
      )
    }
    if (contextSkips.upstream) {
      disclosures.push(
        `${contextSkips.upstream} finding(s) sit in comments last written by a commit of the upstream remote \`${ctx.upstreamRemote}\` — inherited, not this fork's to fix; skipped, not flagged.`,
      )
    }
    if (promotionSkips.bareInvocations) {
      disclosures.push(
        `${promotionSkips.bareInvocations} bare \`pnpm X\` / \`yarn X\` / \`bun X\` mention(s) in comments were not read as scripts — in a sentence that shape is a phrase as often as an invocation; skipped, not flagged.`,
      )
    }
    if (promotionSkips.proseScripts) {
      disclosures.push(
        `${promotionSkips.proseScripts} \`… run X\` mention(s) in comments put a function word where a script name would be; read as prose, skipped.`,
      )
    }
    if (promotionSkips.hostnameLike) {
      disclosures.push(
        `${promotionSkips.hostnameLike} slash token(s) in comments start with a host name — URLs, not repo paths; skipped.`,
      )
    }
    if (promotionSkips.unrootedDirs) {
      disclosures.push(
        `${promotionSkips.unrootedDirs} slash-joined phrase(s) ending in \`/\` in comments start with no directory that exists here — read as prose; skipped, not flagged.`,
      )
    }
    if (promotionSkips.namespaced) {
      disclosures.push(
        `${promotionSkips.namespaced} slash token(s) in comments carry a namespace label (\`app:src/x.ts\` shape) — the label names another scope's paths, not this repo's root; skipped, not flagged.`,
      )
    }

    return {
      lens: LENS_ID,
      version: "1",
      title: "Source comment truth",
      kind: "truth",
      status: "ran",
      // Per-comment truncation notices name the file, so several comments in one file can emit
      // the same line — the report shows each disclosure once.
      disclosures: [...new Set(disclosures)],
      findings,
      outOfScope,
    }
  },
}
