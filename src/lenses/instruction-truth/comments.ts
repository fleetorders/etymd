// Comment extraction — the source-code half of the truth surface. Instruction files are prose an
// agent is told to obey; comments are prose every maintainer and agent reading the code is told
// to trust, and they rot the same way: a written rule that happens to sit in a `.ts` file. The
// scanner is per language and string-aware by design — misreading string content as a comment
// would MANUFACTURE claims (the exact false-positive class claims.ts exists to avoid), while
// misreading a comment as code only loses one.

/** One comment: its text with delimiters stripped, and the line it starts on. */
export interface CommentSpan {
  text: string
  /** 1-based line of the comment's opening delimiter. */
  line: number
}

interface CommentStyle {
  /** Line-comment opener; the comment runs to end of line. */
  line?: string
  /** Block-comment delimiters, `[open, close]`. */
  block?: [string, string]
  /** Quote characters that open a string the scanner must skip (escapes honored). */
  strings?: string[]
  /** Triple-quoted strings span lines — skip them whole (Python docstrings). */
  tripleQuotes?: boolean
  /** `--` must be followed by whitespace or EOL (in SQL, `--` is also arithmetic). */
  dashGuard?: boolean
  /** `#` must sit at the start of a word (shell, YAML): mid-word `#` — `${f#prefix}` — is code. */
  hashGuard?: boolean
  /** `/` in expression-start position opens a regex literal (JS family): pattern text is not comments. */
  regex?: boolean
}

const JS: CommentStyle = { line: "//", block: ["/*", "*/"], strings: ["'", '"', "`"], regex: true }
const C_LIKE: CommentStyle = { line: "//", block: ["/*", "*/"], strings: ["'", '"'] }
const SCSS: CommentStyle = { line: "//", block: ["/*", "*/"] }
const CSS: CommentStyle = { block: ["/*", "*/"] }
/** `#` starts a comment anywhere outside a string (Python, Ruby, Perl, GraphQL, TOML, make). */
const HASH: CommentStyle = { line: "#", strings: ["'", '"'] }
/** `#` starts a comment only at the start of a word (shell, YAML, ini — the POSIX word rule). */
const HASH_WORD: CommentStyle = { line: "#", strings: ["'", '"'], hashGuard: true }
const PYTHON: CommentStyle = { line: "#", strings: ["'", '"'], tripleQuotes: true }
const MARKUP: CommentStyle = { block: ["<!--", "-->"] }
const SQL: CommentStyle = { line: "--", block: ["/*", "*/"], strings: ["'", '"'], dashGuard: true }

function exts(list: string, style: CommentStyle): Record<string, CommentStyle> {
  return Object.fromEntries(list.split(" ").map((e) => [e, style]))
}

const byExt: Record<string, CommentStyle> = {
  ...exts("ts tsx cts mts js jsx cjs mjs go", JS),
  ...exts("c h cc cpp cxx hpp hh hxx java kt kts swift m mm cs php rs", C_LIKE),
  ...exts("scss less sass", SCSS),
  css: CSS,
  ...exts("sh bash zsh env fish", HASH_WORD),
  ...exts("yaml yml ini cfg conf", HASH_WORD),
  ...exts("rb pl r toml graphql gql mk", HASH),
  py: PYTHON,
  ...exts("html htm xml svg", MARKUP),
  sql: SQL,
}

/** Extensions whose files mix several grammars — no single comment style covers them. */
export const MIXED_LANGUAGE_EXTS = new Set(["vue", "svelte", "astro"])

// Lockfiles and vendored basenames: not source a maintainer annotates, and yarn/pnpm locks carry
// generated headers a comment scanner has no business judging.
const SKIPPED_BASENAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"])

/**
 * The comment style for one repo-relative path, or null when the file is not a language the
 * scanner reads (markdown and JSON carry no comments; mixed-language templates are named as a
 * class by the lens rather than guessed at here).
 */
export function commentStyleFor(rel: string): CommentStyle | null {
  const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase()
  if (SKIPPED_BASENAMES.has(base)) return null
  // Dockerfile: `#` mid-line reaches the instruction's argument (ENV A=1#2 keeps the #) — word rule.
  // make: `#` starts a comment anywhere on a line, mid-word included (GNU make lexes it first).
  if (base === "dockerfile") return HASH_WORD
  if (base === "makefile") return HASH
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return null
  return byExt[base.slice(dot + 1)] ?? null
}

const IDENT = /[A-Za-z0-9_$]/
// Words after which a `/` opens a regex, not division. `)`/`]`/`}` and a closed quote end an
// expression (division); every other operator or punctuator leaves a `/` as a regex opener.
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
])

/**
 * True when the `/` at `i` stands in expression-start position, judged from `prev` — the last
 * code character consumed outside strings and comments. A heuristic by necessity (only a real
 * parser disambiguates division from regex), but a conservative one: every shape it misreads as
 * division merely loses a comment, while the shape it exists to fix — `\/*` inside a regex
 * literal read as a block comment — swallows live code into comment text and manufactures
 * claims.
 */
function regexPosition(source: string, i: number, prev: string): boolean {
  if (prev === "") return true
  if (IDENT.test(prev)) {
    // An identifier precedes: division (`a / b`) unless that identifier is a keyword
    // (`return /re/.test(x)`) — walk the trailing word back.
    let j = i
    while (j > 0 && IDENT.test(source[j - 1] as string)) j -= 1
    return REGEX_KEYWORDS.has(source.slice(j, i))
  }
  return !")]}.".includes(prev) && !"'\"`".includes(prev)
}

/**
 * The index just past the regex literal opened at `i`, or -1: scan for the closing unescaped
 * `/`, honoring `\` escapes and `[...]` classes (a `/` inside a class does not close the
 * literal), then any flags. A literal newline means this was never a regex — regex literals
 * cannot span lines — so the caller falls back to reading the `/` as an operator.
 */
function regexLiteralEnd(source: string, i: number, n: number): number {
  let inClass = false
  for (let j = i + 1; j < n; j++) {
    const c = source[j] as string
    if (c === "\\") {
      j += 1
      continue
    }
    if (c === "\n") return -1
    if (inClass) {
      if (c === "]") inClass = false
      continue
    }
    if (c === "[") inClass = true
    else if (c === "/") {
      let k = j + 1
      while (k < n && /[a-z]/.test(source[k] as string)) k += 1
      return k
    }
  }
  return -1
}

/**
 * Extract every comment span from source text under one style. Single-pass and allocation-light:
 * audits run this over every tracked file, so the cost must stay proportional to the file.
 */
export function extractComments(source: string, style: CommentStyle): CommentSpan[] {
  const spans: CommentSpan[] = []
  const n = source.length
  let i = 0
  let line = 1
  // The last code character outside strings and comments (whitespace never counts): the one
  // piece of lexer state the regex-literal rule needs.
  let prev = ""

  const countLines = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (source[k] === "\n") line += 1
  }

  while (i < n) {
    const ch = source[i] as string
    if (ch === "\n") {
      line += 1
      i += 1
      continue
    }

    // A `/` in expression-start position opens a regex literal whose body may contain `/*` or
    // `//` — pattern text, never comment delimiters. `/*` and `//` right after the opener are
    // left to the comment branches below (a regex cannot start with a bare quantifier, and
    // `//` is lexed as a comment by every real engine).
    if (
      style.regex &&
      ch === "/" &&
      source[i + 1] !== "*" &&
      source[i + 1] !== "/" &&
      regexPosition(source, i, prev)
    ) {
      const end = regexLiteralEnd(source, i, n)
      if (end > i) {
        countLines(i, end)
        i = end
        prev = "/"
        continue
      }
    }

    if (style.block && source.startsWith(style.block[0], i)) {
      const body = i + style.block[0].length
      const close = source.indexOf(style.block[1], body)
      const end = close === -1 ? n : close
      const text = source.slice(body, end)
      if (text.trim()) spans.push({ text, line })
      countLines(i, close === -1 ? n : close + style.block[1].length)
      i = close === -1 ? n : close + style.block[1].length
      continue
    }

    if (style.line && source.startsWith(style.line, i)) {
      const opener = style.line
      const after = source[i + opener.length] ?? ""
      // The dash guard keeps `a--b` (arithmetic) out of the comment class; the hash guard keeps
      // mid-word `#` out of it — `${f#src/…}` is parameter expansion, and a `#` only opens a
      // comment at the start of a word: after whitespace, line start, or a shell metacharacter.
      const dashBlocked = style.dashGuard && after !== "" && !/[ \t]/.test(after)
      const hashBlocked =
        style.hashGuard && i > 0 && !/[ \t\n;&()|<>]/.test(source[i - 1] as string)
      if (!dashBlocked && !hashBlocked) {
        const body = i + opener.length
        const eol = source.indexOf("\n", body)
        const end = eol === -1 ? n : eol
        const text = source.slice(body, end)
        if (text.trim()) spans.push({ text, line })
        i = end
        continue
      }
    }

    if (style.tripleQuotes && (source.startsWith('"""', i) || source.startsWith("'''", i))) {
      const quote = source.slice(i, i + 3)
      const close = source.indexOf(quote, i + 3)
      const end = close === -1 ? n : close + 3
      countLines(i, end)
      i = end
      continue
    }

    if (style.strings?.includes(ch)) {
      // Escapes are honored even where the language would not treat `\` as one: staying in-string
      // too LONG only loses a comment, while leaving early would read code as comment text.
      // Backtick strings span lines (and must count their own newlines); single and double
      // quotes end at the newline.
      const multiline = ch === "`"
      let j = i + 1
      while (j < n) {
        const c = source[j] as string
        if (c === "\\") {
          j += 2
          continue
        }
        if (c === ch) break
        if (!multiline && c === "\n") break
        j += 1
      }
      countLines(i, j)
      i = j < n && source[j] === ch ? j + 1 : j
      // A closed string ends an expression: the character after it positions any later `/`.
      prev = ch
      continue
    }

    // Whitespace is not lexer state — `a / b` must still see the `a` at the `/`.
    if (!/[ \t\r]/.test(ch)) prev = ch
    i += 1
  }
  return spans
}
