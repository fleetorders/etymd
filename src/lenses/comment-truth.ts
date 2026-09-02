import path from "node:path"

import type { Finding, Lens, LensContext, LensReport } from "../engine/finding.js"
import { listRootedDirs, promoteBareTokens } from "../engine/premise.js"
import { git, readText } from "../core/util.js"
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
  commentStyleFor,
  extractComments,
  MIXED_LANGUAGE_EXTS,
} from "./instruction-truth/comments.js"

// The comment-truth lens: the four claim checkers (script, path, doc, decision) over source-code
// COMMENTS, not just instruction files — decision 011. A comment is a written rule that happens to
// live in a `.ts` file; it rots the same way an AGENTS.md line does, and nothing else in the repo
// checks it. The checks themselves are the shared ones (checks.ts) with the premise surface's
// prose promotion, so a third copy of the precision rules can never drift in beside them.

const LENS_ID = "comment-truth"
const MAX_FILES = 2000
const MAX_FILE_BYTES = 1_000_000
const MAX_PATH_FINDINGS_PER_FILE = 10
const MAX_EVIDENCE_LINES = 3

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

export const commentTruthLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Source comment truth",
  kind: "truth",
  async run(ctx: LensContext): Promise<LensReport> {
    const { root, facts } = ctx
    if (!facts.git.isRepo) {
      return skippedLens("not a git repository — tracked source files cannot be enumerated")
    }
    const listed = await git(root, ["ls-files", "-z"])
    if (!listed)
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

    const findings: Finding[] = []
    const disclosures: string[] = []
    const counters = emptyCounters()
    const promotionSkips = {
      bareInvocations: 0,
      proseScripts: 0,
      hostnameLike: 0,
      unrootedDirs: 0,
    }

    const env = await buildTruthEnv(root, facts)
    const pathResolves = cached(env.pathResolves)
    const binResolves = cached(env.binResolves)
    const scopedEnv: TruthEnv = { ...env, pathResolves, binResolves }
    const ledger = await loadDecisionLedger(root, facts)
    const rootedDirs = await listRootedDirs(env)

    let filesWithComments = 0
    let commentCount = 0
    for (const rel of scanTargets) {
      const text = await readText(path.join(root, rel))
      if (text === null) continue
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
        outOfScope.push(rel)
        continue
      }
      const style = commentStyleFor(rel)
      if (!style) continue
      const spans = extractComments(text, style)
      if (!spans.length) continue
      filesWithComments += 1

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

      for (const span of spans) {
        commentCount += 1
        const subject = `${rel}:${span.line}`
        const promoted = promoteBareTokens(span.text, { rootedDirs })
        for (const key of Object.keys(promotionSkips) as (keyof typeof promotionSkips)[]) {
          promotionSkips[key] += promoted.skips[key]
        }
        const file = { path: rel, text: promoted.text }
        const claims = await checkTextClaims(
          scopedEnv,
          file,
          {
            lensId: LENS_ID,
            subject,
            missingPathTier: "gap",
            maxPathFindings: MAX_PATH_FINDINGS_PER_FILE,
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
        addAll(claims.findings)
        disclosures.push(...claims.disclosures)
        addAll((await checkDocRefs(scopedEnv, file, LENS_ID, counters, subject)).findings)
        addAll(
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
        )
      }
      findings.push(...byId.values())
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
