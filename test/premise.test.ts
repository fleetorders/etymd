import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { meetsFailOn } from "../src/engine/finding.js"
import { PREMISE_BRIEF_FILE, promoteBareTokens, runPremise } from "../src/engine/premise.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-premise-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

async function fixture() {
  await write("package.json", JSON.stringify({ name: "demo", scripts: { build: "tsup" } }))
  // An installed node_modules makes unknown commands checkable rather than "unverifiable".
  await write("node_modules/.bin/.keep", "")
  await write("src/real.ts", "export const x = 1\n")
  await write("AGENTS.md", "# AGENTS.md\n")
  await write("DECISIONS.md", "# Decisions\n\n## D-001 — 2026-01-01 — first\n\nScope: repo.\n")
}

describe("promoteBareTokens", () => {
  it("wraps bare paths, dirs and package-manager invocations, leaving code spans alone", () => {
    const out = promoteBareTokens(
      "Fix src/a.ts and docs/design/, then run npm run build; keep `src/b.ts` and Node.js as is. Skim docs/ too.",
    )
    expect(out).toContain("`src/a.ts`")
    expect(out).toContain("`docs/design/`")
    // A single segment with a trailing slash (`docs/`) is prose to the extractor as well.
    expect(out).not.toContain("`docs/`")
    expect(out).toContain("`npm run build`")
    expect(out).toContain("`src/b.ts`")
    expect(out).not.toContain("``src/b.ts``")
    // A bare file name without a directory is prose unless the author backticks it.
    expect(out).not.toContain("`Node.js`")
  })

  it("keeps trailing punctuation outside the span and skips URLs", () => {
    const out = promoteBareTokens("Look at (src/x/y.ts). See https://example.com/a/b.ts too.")
    expect(out).toContain("(`src/x/y.ts`).")
    expect(out).not.toContain("`https://example.com/a/b.ts`")
  })
})

describe("runPremise", () => {
  it("ranks a missing named path as risk, a dead script as risk, a dead decision as gap", async () => {
    await fixture()
    const result = await runPremise({
      root: dir,
      task: "Fix the flaky test in src/legacy/foo.test.ts, make npm run lint pass, and update src/real.ts per D-009.",
    })
    const ids = result.findings.map((f) => f.id)
    expect(ids).toContain("premise/stale-path:task:src/legacy/foo.test.ts")
    expect(ids).toContain("premise/stale-command:task:lint")
    expect(ids).toContain("premise/dead-decision-ref:task:D-009")
    const byId = Object.fromEntries(result.findings.map((f) => [f.id, f]))
    expect(byId["premise/stale-path:task:src/legacy/foo.test.ts"]?.tier).toBe("risk")
    expect(byId["premise/stale-command:task:lint"]?.tier).toBe("risk")
    expect(byId["premise/dead-decision-ref:task:D-009"]?.tier).toBe("gap")
    // The existing path is reported as checked and present, not as a finding.
    expect(result.entities).toContainEqual({ kind: "path", value: "src/real.ts", exists: true })
    expect(ids).not.toContain("premise/stale-path:task:src/real.ts")
    expect(meetsFailOn(result.findings, "risk")).toBe(true)
  })

  it("reports a clean task with no findings and the premises handed to the agent", async () => {
    await fixture()
    const result = await runPremise({ root: dir, task: "Tidy src/real.ts and run npm run build." })
    expect(result.findings).toEqual([])
    expect(result.entities.map((e) => e.value).sort()).toEqual(["build", "src/real.ts"])
    expect(result.brief).toContain("Premises only you can verify")
    expect(result.brief).toContain("Tidy src/real.ts")
    expect(result.disclosures.some((d) => d.includes("no ledger"))).toBe(true)
  })

  it("names the nothing-to-check case instead of looking clean by silence", async () => {
    await fixture()
    const result = await runPremise({ root: dir, task: "Make the onboarding feel less abrupt." })
    expect(result.findings).toEqual([])
    expect(result.entities).toEqual([])
    expect(result.disclosures[0]).toMatch(/nothing etymd can check/)
  })

  it("leaves zero trace in a repo that never opted in, and writes the brief where it did", async () => {
    await fixture()
    const cold = await runPremise({ root: dir, task: "Touch src/real.ts" })
    expect(cold.briefPath).toBeNull()
    await expect(fs.access(path.join(dir, ".etymd"))).rejects.toThrow()

    await fs.mkdir(path.join(dir, ".etymd"), { recursive: true })
    const warm = await runPremise({ root: dir, task: "Touch src/real.ts" })
    expect(warm.briefPath).toBe(PREMISE_BRIEF_FILE)
    const written = await fs.readFile(path.join(dir, PREMISE_BRIEF_FILE), "utf8")
    expect(written).toBe(warm.brief)

    const silent = await runPremise({ root: dir, task: "Touch src/real.ts", writeBrief: false })
    expect(silent.briefPath).toBeNull()
  })

  it("reads the task from a file source label unchanged", async () => {
    await fixture()
    const result = await runPremise({ root: dir, task: "Read src/real.ts", source: "PLAN.md" })
    expect(result.source).toBe("PLAN.md")
    expect(result.schema).toBe("premise/1")
  })
})
