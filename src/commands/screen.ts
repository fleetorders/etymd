import { promises as fs } from "node:fs"
import path from "node:path"

import { git, pathExists, readText } from "../core/util.js"
import { print, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

/**
 * The content screen: does this repo carry text that must never be published?
 *
 * Etymd ships the MECHANISM and no policy. There are no built-in patterns and there never will
 * be — the strings worth screening for (an organisation's name, a hostname, an account identifier)
 * are themselves the sensitive material, so a shipped list would be both useless to everyone
 * else and a leak for whoever wrote it. The user supplies a pattern file; without one this
 * command is inert and says so.
 *
 * Four doors, because a leak walks through whichever is unguarded:
 *
 *   --staged   what a commit is about to add       (pre-commit)
 *   --message  the commit message itself           (commit-msg — the staged scan cannot see it)
 *   --tree     every tracked file                  (pre-push: what is about to leave the machine)
 *   --dir      an unpacked build artifact          (prepublish: what actually SHIPS)
 *
 * The last one exists because the others share a blind spot: they all answer "what is in the
 * repository?". A gitignored file can still be packaged into a published artifact — npm and
 * vsce do not honour .gitignore — so every git-scoped check can pass forever while the bytes go
 * out to users.
 */

export type ScreenScope = "staged" | "tree" | "message" | "dir"

/**
 * Pattern classes. A pattern file is a flat list by default and every pattern is `secret` —
 * blocks everywhere, always. A `# class: vocabulary` directive line switches the class for the
 * patterns beneath it (a `# class: secret` line switches back). Vocabulary-class patterns are
 * words that indicate a leaky DESCRIPTION rather than a secret string — and the same words occur
 * in a fork's UPSTREAM documentation, which is already public. Vocabulary-class patterns and the
 * machine-path check are skipped only on files proven to be upstream-owned (see `--upstream`): such
 * a file is byte-identical to public upstream, so any path it names is already public and cannot
 * leak this machine. Secret-class patterns are absolute — they never skip, on any file.
 */
export type PatternClass = "secret" | "vocabulary"
export interface ScreenPattern {
  re: RegExp
  cls: PatternClass
}
/** A `# class: <name>` line switches the class of the patterns that follow it. */
const CLASS_DIRECTIVE = /^#[ \t]*class:[ \t]*(secret|vocabulary)\b/i

export interface ScreenOptions {
  cwd: string
  scope: ScreenScope
  /** Message file (commit-msg hook `$1`) or the directory to walk, per scope. */
  target?: string
  patterns?: string
  /** Report without failing — the pre-push door is advisory by default. */
  advisory?: boolean
  /**
   * The name of this repo's upstream remote (a fork). When set, a staged/tree file whose content
   * is byte-identical to any blob at the tips of `refs/remotes/<upstream>/*` is treated as
   * upstream-owned: vocabulary-class patterns and the machine-path check are skipped for it
   * (secret-class stays absolute).
   * Fails closed — if the remote's refs cannot be read, nothing is exempted and a notice is
   * printed, so a fork whose upstream vanished screens fully and visibly rather than silently.
   */
  upstream?: string
}

/** Absolute home paths name the machine (and usually the person) — checked structurally. */
const MACHINE_PATH_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//

/** An inline escape hatch for a line that must legitimately contain a screened string. */
const ALLOW_MARKER = "allow-published-string"

/**
 * Repo-level exceptions — ONE FILE, one labeled line per field.
 *
 * A `pattern` line opens a record and the pattern is the REST of that line, verbatim:
 *
 *   pattern ^/Users/someone
 *   reason test fixture for machine-path detector
 *   date 2026-08-15
 *   author owner
 *
 * No in-band delimiter, so a pattern may contain any character — including `|`, spaces,
 * anything — without escaping. Delimiting a free-form field in-band is an ambiguity in the
 * FORMAT (every guard in the parser only makes some misparses loud and leaves the rest
 * silent); labels move the boundary to the line break, which the field cannot contain.
 *
 * Self-name exemptions (a repo naming itself) need no provenance — a bare pattern line is a
 * complete record:
 *
 *   ^widget$
 *
 * Why provenance matters: every exemption is a hole in the gate. Without a date and author,
 * a stale entry lives forever because nobody can ask "is this still needed?". With it, you
 * can audit: "why did we exempt this string six months ago, and is the reason still valid?"
 * A record missing its fields is reported and does not apply — never guessed at.
 *
 * This file covers the lines you cannot edit inline: a scanner's own source necessarily
 * contains the patterns it screens for, its tests contain fixtures that must match, and a
 * bundler strips comments so an inline marker would not survive into the artifact. Without it
 * those files can never pass their own screen.
 *
 * It is a hole in the gate by construction, so it is read from the repo being screened,
 * never from a shared location, and the file screens itself out (it contains every string
 * it exempts).
 */
const ALLOW_FILE = ".etymd-screen-allow"
/** The previous tool's filename, still honoured so a migrated repo keeps its exceptions. */
const LEGACY_ALLOW_FILE = ".artifact-check-allow"

export interface ScreenHit {
  file: string
  line: number
  text: string
  reason: string
}

interface AllowEntry {
  pattern: RegExp
  reason?: string
  date?: string
  author?: string
  isSelfName: boolean
}

/** A field label and its value, for lines like `reason fixture text`. */
const LABELED_LINE = /^(pattern|reason|date|author)[ \t]+(.*)$/

/**
 * Read the allow file as records of labeled lines. Exported for tests only.
 *
 * A `pattern` line (or any unlabeled line — that is the self-name shorthand) opens a record;
 * `reason`/`date`/`author` lines fill the open one. Records missing their provenance are
 * RETURNED, not dropped — the run-level validation reports them, so an incomplete entry is
 * noise to fix rather than silence to trust.
 *
 * An orphan provenance line (no open record) is dropped without a warning, deliberately: it
 * exempts nothing, and the dangerous direction for an allow file is over-exemption, not
 * under-exemption — a pattern nobody wrote simply never matches, and the hit it would have
 * covered is still reported at the door that sees it.
 */
export function compileAllow(raw: string): AllowEntry[] {
  const entries: AllowEntry[] = []
  let current: AllowEntry | null = null
  const close = () => {
    if (current) entries.push(current)
    current = null
  }
  for (const rawLine of raw.split("\n")) {
    const l = rawLine.trim()
    if (!l || l.startsWith("#")) continue
    const labeled = LABELED_LINE.exec(l)
    if (labeled) {
      // Both groups always participate in a match; the defaults are for the type system.
      const [, label = "", value = ""] = labeled
      if (label === "pattern") {
        close()
        current = makeAllowEntry(value)
      } else if (current) {
        if (label === "reason") current.reason = value.trim()
        else if (label === "date") current.date = value.trim()
        else current.author = value.trim()
      }
    } else {
      close()
      current = makeAllowEntry(l)
    }
  }
  close()
  return entries
}

/** Compile one pattern, matching malformed input literally rather than dropping it. */
function makeAllowEntry(patternStr: string): AllowEntry {
  try {
    return { pattern: new RegExp(patternStr, "i"), isSelfName: false }
  } catch {
    // A malformed pattern must never be silently dropped — match it literally instead.
    return {
      pattern: new RegExp(patternStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      isSelfName: false,
    }
  }
}

/** Compile one pattern line, matching malformed input literally rather than dropping it. */
function compileOnePattern(l: string): RegExp {
  try {
    return new RegExp(l, "i")
  } catch {
    // A malformed pattern must never be silently dropped — match it literally instead.
    return new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
  }
}

/**
 * Compile pattern file (not allow-file) into classed patterns. Exported for tests.
 *
 * Pattern files are simple lists, one per line; a `# class: secret|vocabulary` directive switches
 * the class of the lines beneath it. The default before any directive is `secret`, so a file with
 * no directive behaves exactly as before — every pattern absolute.
 */
export function compilePatterns(raw: string): ScreenPattern[] {
  const out: ScreenPattern[] = []
  let cls: PatternClass = "secret"
  for (const rawLine of raw.split("\n")) {
    const l = rawLine.trim()
    if (!l) continue
    const dir = CLASS_DIRECTIVE.exec(l)
    if (dir) {
      cls = dir[1]!.toLowerCase() as PatternClass
      continue
    }
    if (l.startsWith("#")) continue
    out.push({ re: compileOnePattern(l), cls })
  }
  return out
}

/** Regex metacharacters that, unescaped, mean a pattern is more than a plain literal. */
const META = ".[]*^$+?(){}|"

/**
 * The exact string a pattern matches, or `null` if it matches more than one string.
 *
 * The self-name exemption is a comparison of MEANING, not of spelling: `\bwidget\b` and `widget`
 * pick out the same name and must be treated alike. Comparing raw sources instead is what broke
 * this exemption once already — a generator started emitting its names word-anchored, every
 * source stopped matching the bare name, and the exemption silently stopped applying while its
 * code, its comment and its test all still looked correct. Nothing failed; a repo simply began
 * reporting its own `package.json` as a leak.
 *
 * Word anchors are accepted because they do not change WHICH string is matched, only where a
 * match may begin and end. Anything else — a character class, a quantifier, an alternation —
 * makes the pattern broader than a name, and a broader pattern is never exempt: an exemption
 * must be exactly as wide as the repo's own name and no wider.
 */
export function patternLiteral(source: string): string | null {
  let out = ""
  let i = source.startsWith("\\b") ? 2 : 0
  for (; i < source.length; i++) {
    // charAt rather than indexing: every position here is in range, and an index signature that
    // admits `undefined` would only be silenced with a non-null assertion.
    const c = source.charAt(i)
    if (c === "\\") {
      const next = source[i + 1]
      if (next === undefined) return null
      // `\b` is an anchor, meaningful here only as the closing one; `\d`, `\w`, `\s` and friends
      // all match more than a literal. Every other escape is just a quoted character.
      if (/[A-Za-z0-9]/.test(next)) return next === "b" && i + 2 === source.length ? out : null
      out += next
      i++
      continue
    }
    if (META.includes(c)) return null
    out += c
  }
  return out
}

/**
 * Is this pattern one of the names the repo may legitimately call itself?
 *
 * `selves` is a union rather than a single name because the three places a repo states its own
 * identity — its directory, its package manifest, its remote — routinely disagree, and a name
 * the repo can prove is its own is not a disclosure of anyone else's project.
 */
export function isSelfName(pattern: RegExp, selves: readonly string[]): boolean {
  const literal = patternLiteral(pattern.source)
  if (literal === null || literal === "") return false
  return selves.some((s) => s.toLowerCase() === literal.toLowerCase())
}

/** Strip an npm scope and a `.git` suffix — `@org/widget` and `widget.git` are both `widget`. */
function bareName(raw: string): string {
  return raw.replace(/^@[^/]+\//, "").replace(/\.git$/, "")
}

/**
 * Every name this repo can PROVE is its own: its worktree directory, its package manifest's
 * `name`, and the basename of its `origin` remote.
 *
 * Proof is the operative word — each source is read from the repo being screened, so a repo can
 * only ever exempt itself. Where none of the three can be read the result is empty, which
 * exempts nothing and leaves every pattern active: a repo whose identity cannot be established
 * is screened in full rather than trusted.
 */
export async function selfIdentities(cwd: string): Promise<string[]> {
  const names = new Set<string>()

  const top = await git(cwd, ["rev-parse", "--show-toplevel"])
  names.add(path.basename(top || path.resolve(cwd)))

  const pkg = await readText(path.join(top || cwd, "package.json"))
  if (pkg) {
    try {
      const name = (JSON.parse(pkg) as { name?: unknown }).name
      if (typeof name === "string" && name) names.add(bareName(name))
    } catch {
      // An unparseable manifest states no identity; the other two sources still do.
    }
  }

  const remote = await git(cwd, ["remote", "get-url", "origin"])
  if (remote) names.add(bareName(path.basename(remote.trim())))

  names.delete("")
  return [...names]
}

export function screenText(
  text: string,
  file: string,
  patterns: readonly (RegExp | ScreenPattern)[],
  allow: AllowEntry[] = [],
  upstreamOwned = false,
): ScreenHit[] {
  // A bare RegExp is treated as secret-class, so every existing caller and test is unchanged.
  const classed = patterns.map((p) =>
    p instanceof RegExp ? { re: p, cls: "secret" as PatternClass } : p,
  )
  // On an upstream-owned file the vocabulary class is dropped (its matches are upstream's own public
  // wording) and the machine-path check below is skipped too — the file is byte-identical to public
  // upstream, so any path it names is already public. Secret-class patterns still never skip.
  const active = upstreamOwned ? classed.filter((p) => p.cls === "secret") : classed
  const hits: ScreenHit[] = []
  const lines = text.split("\n")
  for (const [i, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) continue
    if (allow.some((entry) => entry.pattern.test(line))) continue
    for (const { re } of active) {
      if (re.test(line)) {
        hits.push({ file, line: i + 1, text: line.trim().slice(0, 160), reason: String(re) })
        break
      }
    }
    if (!upstreamOwned && MACHINE_PATH_RE.test(line)) {
      hits.push({
        file,
        line: i + 1,
        text: line.trim().slice(0, 160),
        reason: "absolute home path",
      })
    }
  }
  return hits
}

/**
 * Every blob object-id at the tips of the upstream remote's refs. A fork copies upstream files
 * verbatim — sometimes to a DIFFERENT path (an adapter lifted from `upstream/channels` into an
 * `add-*` skill) — so ownership is decided by CONTENT identity (the blob sha) across ALL upstream
 * refs, not by path: a byte-identical copy shares the blob wherever it sits. Returns null when no
 * upstream refs can be read, so the caller exempts nothing and says so — a fork whose upstream
 * vanished then screens fully and visibly rather than silently trusting a gap.
 */
export async function collectUpstreamBlobs(
  cwd: string,
  remote: string,
): Promise<Set<string> | null> {
  const refsRaw = await git(cwd, ["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`])
  const refs = (refsRaw ?? "").split("\n").filter(Boolean)
  if (!refs.length) return null
  const blobs = new Set<string>()
  for (const ref of refs) {
    const tree = await git(cwd, ["ls-tree", "-r", ref])
    if (tree === null) continue
    for (const line of tree.split("\n")) {
      // `<mode> blob <sha>\t<path>` — a submodule line is `commit`, not `blob`, and is ignored.
      const m = /^\d+ blob ([0-9a-f]+)\t/.exec(line)
      if (m) blobs.add(m[1]!)
    }
  }
  return blobs.size ? blobs : null
}

/**
 * The staged (index) blob sha for every tracked path — how a file will be committed. Compared
 * against the upstream blob set to decide upstream ownership with no content read and no hashing.
 */
export async function stagedBlobShas(cwd: string): Promise<Map<string, string>> {
  const raw = await git(cwd, ["ls-files", "-s"])
  const map = new Map<string, string>()
  for (const line of (raw ?? "").split("\n")) {
    // `<mode> <sha> <stage>\t<path>`
    const m = /^\d+ ([0-9a-f]+) \d+\t(.+)$/.exec(line)
    if (m) map.set(m[2]!, m[1]!)
  }
  return map
}

async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 12) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) await walk(abs, out, depth + 1)
    else out.push(abs)
  }
}

/**
 * How many leading bytes decide whether a file is text. A NUL byte cannot occur
 * in valid UTF-8 text, and every binary container this screen meets in practice
 * — images, archives, compiled output — carries one early.
 */
const BINARY_SNIFF_BYTES = 8192

/**
 * Read a file for screening, or report that it is binary.
 *
 * Compressed bytes will contain any short sequence eventually, so a short
 * pattern hits a binary asset every so often, reported as a "line" of mojibake.
 * That made every ADDED pattern raise the false-positive rate across every repo
 * holding assets — and the cost of a noisy gate is not the noise, it is that the
 * answer becomes "bypass again" until a real finding is waved through with the
 * rest.
 *
 * Skipping non-text closes that for every pattern at once, which is what this
 * file's own doctrine prefers: remove the surface rather than add a rule.
 * Deliberately NOT folded into core `readText` — that helper serves detect,
 * context and generate, none of which want a Buffer read or this policy.
 *
 * Returns the text, `null` if unreadable, or "binary" if it should be skipped —
 * three outcomes, because a caller that cannot tell "skipped" from "missing"
 * cannot report the skip, and an unreported skip is the silent hole this was
 * supposed to avoid.
 */
export async function readScreenable(p: string): Promise<string | null | "binary"> {
  let buf: Buffer
  try {
    buf = await fs.readFile(p)
  } catch {
    return null
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return "binary"
  return buf.toString("utf8")
}

export async function run(opts: ScreenOptions): Promise<void> {
  const patternPath =
    opts.patterns ??
    process.env.ETYMD_SCREEN_PATTERNS ??
    process.env.PUBLIC_REPO_PATTERNS ??
    path.join(process.env.HOME ?? "", ".config", "etymd", "screen-patterns")

  const rawPatterns = await readText(patternPath)
  if (rawPatterns === null) {
    // Inert without policy, and honest about it: silence here would read as "screened, clean".
    print(
      `  ${glyph.partial} ${theme.dim(`no pattern file at ${patternPath} — nothing to screen against.`)}`,
    )
    print(
      `  ${theme.dim("Etymd ships no patterns by design: the strings worth screening for are themselves sensitive. Write one line per pattern (regex or literal, # for comments).")}`,
    )
    return
  }
  const patterns = compilePatterns(rawPatterns)
  if (!patterns.length) {
    print(`  ${glyph.partial} ${theme.dim(`${patternPath} has no active patterns — skipping.`)}`)
    return
  }

  // Repo-level exceptions, read from the repo being screened.
  const usingLegacy =
    !(await pathExists(path.join(opts.cwd, ALLOW_FILE))) &&
    (await pathExists(path.join(opts.cwd, LEGACY_ALLOW_FILE)))
  const allowRaw = usingLegacy
    ? await readText(path.join(opts.cwd, LEGACY_ALLOW_FILE))
    : await readText(path.join(opts.cwd, ALLOW_FILE))
  const allowEntries = allowRaw ? compileAllow(allowRaw) : []

  // Validate provenance and self-name exemptions
  const selves = await selfIdentities(opts.cwd)
  const validatedEntries = allowEntries.filter((entry) => {
    if (entry.isSelfName) return true // Self-name marked during compilation check

    // Check if this is a self-name exemption
    if (isSelfName(entry.pattern, selves)) {
      entry.isSelfName = true
      return true
    }

    // Non-self-name entries require provenance
    if (!entry.reason || !entry.date || !entry.author) {
      print(
        `  ${glyph.partial} ${theme.warn(`Missing provenance for exemption pattern`)} ${theme.dim(String(entry.pattern))}`,
      )
      print(
        `    ${theme.dim("Format: a `pattern` line, then `reason`, `date`, `author` lines — a bare pattern line is a self-name exemption")}`,
      )
      return false
    }

    return true
  })

  const allow = validatedEntries

  // A repo naming ITSELF is legitimate — its README, its package name and its own docs all have
  // to call the project something. The cross-project rule is about disclosing OTHER projects, so
  // the current repo's own names are dropped from the active patterns. Without this, a pattern
  // list that names your projects flags a repo's every self-reference, which buries whatever
  // real finding the report also contains.
  const active = selves.length ? patterns.filter((p) => !isSelfName(p.re, selves)) : patterns

  // Upstream-owned exemption (forks): a staged/tree file whose content is byte-identical to any
  // upstream blob has its vocabulary-class patterns skipped. Engaged only when there ARE vocabulary
  // patterns AND an upstream remote was named, so every other repo pays no git cost and behaves
  // exactly as before.
  const hasVocab = active.some((p) => p.cls === "vocabulary")
  // A fork opts into the exemption with `--upstream <remote>` or, persistently,
  // `git config etymd.upstream <remote>`. The config is the better signal: it survives a rebuild
  // that drops the remote, so the fork still KNOWS it is a fork and reports the missing ref rather
  // than silently skipping the exemption — the exact "vanished for a week, nobody noticed" gap.
  const upstreamRemote =
    hasVocab && (opts.scope === "staged" || opts.scope === "tree")
      ? (opts.upstream ?? (await git(opts.cwd, ["config", "--get", "etymd.upstream"])) ?? undefined)
      : undefined
  let upstreamBlobs: Set<string> | null = null
  let blobByPath = new Map<string, string>()
  let upstreamNote = ""
  if (upstreamRemote) {
    upstreamBlobs = await collectUpstreamBlobs(opts.cwd, upstreamRemote)
    if (upstreamBlobs === null) {
      // Fail closed and LOUD: a fork whose upstream ref vanished (a rebuild dropped the remote,
      // nobody fetched) must screen fully AND say why — never a silent exemption of nothing.
      upstreamNote = `upstream ref '${upstreamRemote}' unavailable — vocabulary exemption off, screening every pattern`
    } else {
      blobByPath = await stagedBlobShas(opts.cwd)
    }
  }
  const isUpstreamOwned = (rel: string): boolean => {
    if (!upstreamBlobs) return false
    const sha = blobByPath.get(rel)
    return !!sha && upstreamBlobs.has(sha)
  }

  // Warn about legacy allow file usage
  if (usingLegacy) {
    print(
      `  ${glyph.partial} ${theme.warn(`Using legacy ${LEGACY_ALLOW_FILE} file — rename to ${ALLOW_FILE} and add provenance`)}`,
    )
    print(
      `    ${theme.dim("New format: a `pattern` line, then `reason`, `date`, `author` lines per entry")}`,
    )
  }

  const hits: ScreenHit[] = []
  let scanned = 0
  // Counted, not merely skipped: the summary reports it, so "no findings" can
  // never quietly mean "the bytes were never looked at".
  let skippedBinary = 0

  if (opts.scope === "message") {
    const file = opts.target
    if (!file) throw new Error("--message needs the message file path (the commit-msg hook's $1)")
    const raw = await readText(file)
    if (raw === null) return
    // git strips comment lines before storing the message — screening them would be noise.
    const body = raw
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("\n")
    scanned = 1
    hits.push(...screenText(body, "commit message", active, allow))
  } else if (opts.scope === "dir") {
    const dir = opts.target
    if (!dir) throw new Error("--dir needs a directory")
    const files: string[] = []
    await walk(dir, files)
    for (const f of files) {
      const raw = await readScreenable(f)
      if (raw === null) continue
      if (raw === "binary") {
        skippedBinary++
        continue
      }
      scanned++
      hits.push(...screenText(raw, path.relative(dir, f), active, allow))
    }
  } else {
    const listing =
      opts.scope === "tree"
        ? await git(opts.cwd, ["ls-files"])
        : await git(opts.cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACM"])
    const files = (listing ?? "").split("\n").filter(Boolean)
    for (const rel of files) {
      // The allowlist necessarily contains every string it exempts, so screening it would flag
      // each entry against itself — the same reason a scanner is exempt from its own patterns.
      if (rel === ALLOW_FILE || rel === LEGACY_ALLOW_FILE) continue
      const abs = path.join(opts.cwd, rel)
      if (!(await pathExists(abs))) continue
      const raw = await readScreenable(abs)
      if (raw === null) continue
      if (raw === "binary") {
        skippedBinary++
        continue
      }
      scanned++
      hits.push(...screenText(raw, rel, active, allow, isUpstreamOwned(rel)))
    }
  }

  // A broken upstream ref is reported whatever the outcome — the exemption silently doing nothing
  // is the exact invisible-gap this fails-closed to avoid.
  if (upstreamNote) {
    print(`  ${glyph.partial} ${theme.warn(upstreamNote)}`)
  }

  // The summary prints on a clean run too, with its file count: "no findings" must never be
  // indistinguishable from "the bytes were never looked at". Silence on success reads as
  // exactly that, from inside a hook where the exit code is the only other signal.
  section(
    `Content screen ${theme.dim(
      `· ${opts.scope} · ${scanned} file(s)${
        skippedBinary ? ` · ${skippedBinary} binary skipped` : ""
      }`,
    )}`,
  )
  if (!hits.length) {
    print(`  ${glyph.ok} ${theme.dim("clean")}`)
    return
  }
  for (const h of hits) {
    print(`  ${theme.warn(h.file)}${theme.dim(`:${h.line}`)}  ${theme.dim(`(${h.reason})`)}`)
    print(`    ${h.text}`)
  }
  print("")
  print(
    `  ${theme.dim("Publishing exposes ALL history, so this content would be permanent the moment it is committed.")}`,
  )
  print(
    `  ${theme.dim(`Rewrite the line, mark a deliberate one with \`${ALLOW_MARKER}\`, or bypass with --no-verify.`)}`,
  )
  if (!opts.advisory) process.exitCode = 1
}
