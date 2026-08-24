import { promises as fs } from "node:fs"
import path from "node:path"

import { DEFAULT_CONFIG } from "./config.js"
import type { ContextBudget, ContextFile } from "./types.js"
import { approxTokens, pathExists, readText, wordCount } from "./util.js"

// The always-loaded set: files an agent reads on (nearly) every session regardless of task.
// This is the footprint etymd holds down — context is the dominant cost of the loop.
const ALWAYS_LOADED: { path: string; role: string }[] = [
  { path: "AGENTS.md", role: "operating contract" },
  { path: "PROJECT_CONTEXT.md", role: "ground-truth state" },
  { path: "CLAUDE.md", role: "Claude Code pointer" },
  { path: "GEMINI.md", role: "Gemini pointer" },
  { path: ".github/copilot-instructions.md", role: "Copilot instructions" },
  { path: ".cursorrules", role: "Cursor rules (legacy)" },
]

/**
 * Default word count above which a single always-loaded file is worth extracting into an
 * on-demand skill. Overridable per repo via `context.perFileWords` in `.etymd/config.json`.
 */
const EXTRACTION_THRESHOLD = DEFAULT_CONFIG.context.perFileWords

/**
 * A Cursor rule only loads every session when it is genuinely always-applied. Scoped rules
 * (globs, or alwaysApply omitted/false in frontmatter) load on demand and must not inflate the
 * budget — the flagship metric has to be honest to be worth anything.
 */
export function isAlwaysAppliedCursorRule(text: string): boolean {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return true
  const frontmatter = fm[1] ?? ""
  return /^\s*alwaysApply\s*:\s*true\s*$/m.test(frontmatter)
}

/**
 * A stable identity for the BYTES behind a path — device plus inode, so a symlink and its
 * target, or two hardlinks, resolve to the same key. `stat` follows symlinks, which is the point.
 *
 * Null where identity is not knowable (a filesystem reporting no inode, a stat that fails). The
 * caller then counts the file as its own entry, which is the behaviour that predates this.
 */
async function inodeKey(abs: string): Promise<string | null> {
  try {
    const st = await fs.stat(abs)
    return st.ino ? `${st.dev}:${st.ino}` : null
  } catch {
    return null
  }
}

/** How a file is named in output: the entry's own path, plus any aliases pointing at it. */
export function contextFileLabel(file: ContextFile): string {
  return file.aliases?.length ? [file.path, ...file.aliases].join(" → ") : file.path
}

export async function measureContext(
  root: string,
  perFileWords: number = EXTRACTION_THRESHOLD,
): Promise<ContextBudget> {
  const files: ContextFile[] = []
  /**
   * Two instruction names are routinely ONE file — `AGENTS.md` symlinked to `CLAUDE.md` is the
   * common shape, because most harnesses read one name and some read the other. The session
   * loads those bytes once, so the footprint is that file's words once. Counting both inflates
   * the total enough to manufacture an over-budget finding out of nothing, and fires the
   * heavy-file finding twice for a single file — a measurement this lens exists to report
   * honestly cannot be an artefact of how the repo spells its contract.
   */
  const byInode = new Map<string, ContextFile>()

  const record = async (rel: string, role: string, text: string) => {
    const words = wordCount(text)
    const key = await inodeKey(path.join(root, rel))
    const seen = key ? byInode.get(key) : undefined
    if (seen) {
      seen.aliases = [...(seen.aliases ?? []), rel]
      return
    }
    const file: ContextFile = { path: rel, role, words, approxTokens: approxTokens(words) }
    if (key) byInode.set(key, file)
    files.push(file)
  }

  for (const spec of ALWAYS_LOADED) {
    const text = await readText(path.join(root, spec.path))
    if (text === null) continue
    await record(spec.path, spec.role, text)
  }

  const rulesDir = path.join(root, ".cursor", "rules")
  if (await pathExists(rulesDir)) {
    try {
      for (const entry of await fs.readdir(rulesDir)) {
        if (!entry.endsWith(".mdc") && !entry.endsWith(".md")) continue
        const text = await readText(path.join(rulesDir, entry))
        if (text === null || !isAlwaysAppliedCursorRule(text)) continue
        await record(`.cursor/rules/${entry}`, "Cursor rule (always applied)", text)
      }
    } catch {
      /* ignore */
    }
  }

  const totalWords = files.reduce((s, f) => s + f.words, 0)
  return {
    files: files.sort((a, b) => b.words - a.words),
    totalWords,
    totalApproxTokens: approxTokens(totalWords),
    perFileWords,
    extractionCandidates: files.filter((f) => f.words >= perFileWords),
  }
}

export { EXTRACTION_THRESHOLD }
