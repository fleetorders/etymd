// What a comment says ABOUT a path it names. A missing path is a stale reference only when the
// comment points at this repo's tree; a comment may equally name a path as an example of a
// shape, as a file inside a built artifact, or as a file of a sibling repository it names. Each
// reading is decided from the words directly beside the mention, and a finding is dropped only
// when EVERY mention of the path in the comment reads that way — one plain mention keeps it.

/** The text before and after each occurrence of `claim` as a whole path token in `text`. */
export function mentionsOf(text: string, claim: string): { before: string; after: string }[] {
  const out: { before: string; after: string }[] = []
  const isPathChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_.$~/-]/.test(ch)
  let from = 0
  for (;;) {
    const at = text.indexOf(claim, from)
    if (at === -1) break
    from = at + claim.length
    const prev = text[at - 1]
    // A dot-relative claim carries its own leading dot; any other path char before the match
    // means the claim is the tail of a longer token, not this mention.
    if (isPathChar(prev)) continue
    let end = at + claim.length
    if (text[end] === "/") end += 1
    const next = text[end]
    if (isPathChar(next) && !(next === "." && !isPathChar(text[end + 1]))) continue
    out.push({ before: text.slice(0, at), after: text.slice(end) })
  }
  return out
}

const OPENERS_RE = /[\s`'"(\[]+$/
// One earlier member of a list the mention closes: a code span or a bare token, then a separator.
const LIST_ITEM_RE =
  /(?:`[^`\n]*`|[A-Za-z0-9_.$~/-]+)\s*(?:,|\band\b|\bor\b|,\s*and\b|,\s*or\b)\s*$/i
const EXAMPLE_CUE_RE = /(?:\b(?:e\.g\.?|for example|for instance|such as|like)|\bsay)[,:]?$/i

/**
 * Is this mention introduced as an example? "a path like `docs/notes/`", "e.g. `src/x.ts`", and
 * every later member of the list such a cue opens ("such as `a/b.ts`, `c/d/` and `e/f.ts`").
 */
export function isExampleMention(before: string): boolean {
  let lead = before.replace(OPENERS_RE, "")
  for (let i = 0; i < 12; i += 1) {
    if (EXAMPLE_CUE_RE.test(lead)) return true
    const item = LIST_ITEM_RE.exec(lead)
    if (!item) return false
    lead = lead.slice(0, item.index).replace(OPENERS_RE, "")
  }
  return false
}

const ARTIFACT =
  "(?:apk|aab|ipa|zip|tarball|tar|tgz|archive|jar|war|wheel|bundle|image|container|package|artifact)"
const PACKAGED_AFTER_RE = new RegExp(
  `^[\\s\`'")\\]]*(?:back\\s+)?(?:out of|from inside|from within|inside|within|in)\\s+(?:the|an?|each|every)\\s+(?:[A-Za-z-]+\\s+)?${ARTIFACT}\\b`,
  "i",
)
const PACKAGED_BEFORE_RE = new RegExp(
  `\\b(?:out of|inside|within|from|in)\\s+(?:the|an?|each|every)\\s+(?:[A-Za-z-]+\\s+)?${ARTIFACT}\\b[\\s,:'s]*(?:is|has|holds|carries|contains)?[\\s\`'"(\\[]*$`,
  "i",
)

/**
 * Does the comment place this path inside a built artifact ("reads content/build.json back out of
 * the APK")? Such a path is laid out by the build, not by the repository tree.
 */
export function isPackagedMention(before: string, after: string): boolean {
  return PACKAGED_AFTER_RE.test(after) || PACKAGED_BEFORE_RE.test(before)
}

/**
 * The word directly before the mention, when nothing but opening punctuation separates them:
 * a repository name written in front of the path gives that name. `carry` is the tail of the previous comment
 * line, used when the mention opens its own line (a name and its path wrapped across two lines).
 */
export function leadWord(before: string, carry = ""): string | undefined {
  const trimmed = before.replace(/[\s`'"]+$/, "")
  const source = trimmed === "" ? carry.replace(/[\s`'"]+$/, "") : trimmed
  return /(?:^|[\s(\[{,;:'"`])([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(source)?.[1]
}
