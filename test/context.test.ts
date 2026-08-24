import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { contextFileLabel, measureContext } from "../src/core/context.js"
import { contextEconomyLens } from "../src/lenses/context-economy.js"
import type { ProjectFacts } from "../src/core/types.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-context-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Words enough to clear the per-file extraction threshold on their own. */
const HEAVY = `# Contract\n\n${"word ".repeat(4200)}\n`

async function runLens(root: string) {
  return contextEconomyLens.run({
    root,
    facts: { root } as unknown as ProjectFacts,
    profile: "solo",
    baseline: null,
  })
}

describe("context budget — one file read under two names", () => {
  it("PINNED: a symlinked AGENTS.md is counted once, and both names are reported", async () => {
    // The defect: `AGENTS.md -> CLAUDE.md` is the ordinary way to serve harnesses that read
    // different names. Counting both doubled the footprint, which manufactured an over-budget
    // finding out of nothing and fired the heavy-file finding twice for a single file.
    await fs.writeFile(path.join(dir, "CLAUDE.md"), HEAVY, "utf8")
    await fs.symlink("CLAUDE.md", path.join(dir, "AGENTS.md"))

    const budget = await measureContext(dir)
    const single = await measureContext(await onlyClaudeMd())

    expect(budget.files).toHaveLength(1)
    expect(budget.totalWords).toBe(single.totalWords)

    // Both names survive in the output — deduplicating must not hide a file's other name.
    const [entry] = budget.files
    expect(entry?.aliases).toEqual(["CLAUDE.md"])
    expect(contextFileLabel(entry!)).toBe("AGENTS.md → CLAUDE.md")
  })

  it("PINNED: the lens reports one heavy-file finding, naming both, and discloses the merge", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), HEAVY, "utf8")
    await fs.symlink("CLAUDE.md", path.join(dir, "AGENTS.md"))

    const report = await runLens(dir)
    const heavy = report.findings.filter((f) => f.id.startsWith("context-economy/heavy-file:"))

    expect(heavy).toHaveLength(1)
    expect(heavy[0]?.claim).toContain("AGENTS.md → CLAUDE.md")
    // The over-budget finding was the manufactured one; a single 4.2k-word file is under 8000.
    expect(report.findings.some((f) => f.id === "context-economy/total-over-budget")).toBe(false)
    // Silently merging two entries is still a measurement changing under the reader — say it.
    expect(report.disclosures.join("\n")).toContain("are one file (same inode)")
  })

  it("two genuinely separate files are still counted separately", async () => {
    // The control: dedup keys on the inode, so distinct files with identical bytes stay distinct.
    await fs.writeFile(path.join(dir, "CLAUDE.md"), HEAVY, "utf8")
    await fs.writeFile(path.join(dir, "AGENTS.md"), HEAVY, "utf8")

    const budget = await measureContext(dir)
    expect(budget.files).toHaveLength(2)
    expect(budget.files.every((f) => !f.aliases)).toBe(true)
  })

  async function onlyClaudeMd(): Promise<string> {
    const solo = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-context-solo-"))
    await fs.writeFile(path.join(solo, "CLAUDE.md"), HEAVY, "utf8")
    return solo
  }
})
