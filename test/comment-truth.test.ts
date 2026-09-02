import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scanProject } from "../src/core/scan.js"
import type { LensContext, LensReport } from "../src/engine/finding.js"
import { commentTruthLens } from "../src/lenses/comment-truth.js"
import { commentStyleFor, extractComments } from "../src/lenses/instruction-truth/comments.js"

const pExecFile = promisify(execFile)

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-comments-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

/** git init + stage: `git ls-files` reads the index, so no commit is needed. */
async function gitStage() {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }
  await pExecFile("git", ["init", "-q"], { cwd: dir, env })
  await pExecFile("git", ["add", "-A"], { cwd: dir, env })
}

async function runComments(): Promise<LensReport> {
  const facts = await scanProject(dir)
  const ctx: LensContext = { root: dir, facts, profile: "solo", baseline: null }
  return commentTruthLens.run(ctx)
}

describe("comment extraction", () => {
  it("extracts line and block comments with their line numbers", () => {
    const spans = extractComments(
      ["const a = 1 // first", "const b = 2", "/* block", "spanning */", "const c = 3"].join("\n"),
      commentStyleFor("x.ts") as object,
    )
    expect(spans).toEqual([
      { text: " first", line: 1 },
      { text: " block\nspanning ", line: 3 },
    ])
  })

  it("does not read string content as comments (URLs, quotes, templates)", () => {
    const source = [
      'const url = "https://x.dev/a//b"',
      "const s = 'not // a comment'",
      "const t = `multiline",
      "template // stays string`",
      "const ok = 1 // real comment",
    ].join("\n")
    const spans = extractComments(source, commentStyleFor("x.ts") as object)
    expect(spans).toEqual([{ text: " real comment", line: 5 }])
  })

  it("skips python docstrings and reads hash comments", () => {
    const spans = extractComments(
      ['"""docstring with # inside"""', "x = 1 # real", 'y = "str # not comment"'].join("\n"),
      commentStyleFor("x.py") as object,
    )
    expect(spans).toEqual([{ text: " real", line: 2 }])
  })

  it("treats -- followed by whitespace as a SQL comment, not arithmetic", () => {
    const spans = extractComments(
      ["SELECT a--b", "SELECT a -- comment"].join("\n"),
      commentStyleFor("x.sql") as object,
    )
    expect(spans).toEqual([{ text: " comment", line: 2 }])
  })

  it("gives css block comments only, and scss both styles", () => {
    expect(extractComments("a { } // not css", commentStyleFor("x.css") as object)).toEqual([])
    expect(extractComments("a { } // scss line", commentStyleFor("x.scss") as object)).toEqual([
      { text: " scss line", line: 1 },
    ])
  })

  it("maps Dockerfile and lockfile basenames", () => {
    expect(commentStyleFor("deploy/Dockerfile")).toBeTruthy()
    expect(commentStyleFor("pnpm-lock.yaml")).toBeNull()
    expect(commentStyleFor("README.md")).toBeNull()
  })
})

describe("comment-truth lens", () => {
  it("reports a deleted decision, a renamed script, and a moved path — one finding each, with file and line", async () => {
    await write(
      "package.json",
      JSON.stringify({ name: "shape-demo", scripts: { "build:new": "node nothing" } }),
    )
    await write("DECISIONS.md", "# Decisions\n\n## D-001 Keep it small\n\nBody.\n")
    await write(
      "src/app.ts",
      [
        "// See src/legacy/config.ts for the old wiring.",
        "// Per D-002 the runner changed.",
        "// Rebuild with npm run build:old.",
      ].join("\n"),
    )
    // An installed tree (node_modules present) is what makes an unknown command checkable.
    await write("node_modules/.gitkeep", "")
    await gitStage()

    const report = await runComments()
    const claims = report.findings.map((f) => `${f.tier} ${f.claim}`).sort()
    expect(claims).toEqual([
      "gap src/app.ts:1 references `src/legacy/config.ts` — it does not exist in the repo",
      "gap src/app.ts:2 cites D-002 — no such entry exists in DECISIONS.md",
      "risk src/app.ts:3 tells agents to run `build:old` — no such script exists",
    ])
  })

  it("reports nothing for a repo whose comments are all true", async () => {
    await write(
      "package.json",
      JSON.stringify({ name: "shape-demo", scripts: { "build:new": "node nothing" } }),
    )
    await write(
      "DECISIONS.md",
      "# Decisions\n\n## D-001 Keep it small\n\n## D-002 Use the runner\n",
    )
    await write(
      "src/app.ts",
      [
        "// See src/live/config.ts for the wiring.",
        "// Per D-001 we keep it small.",
        "// Rebuild with npm run build:new.",
        'const url = "https://cdn.example.com/x";',
        "// The input/output/ phrase and example.com/foo.ts stay prose.",
        "// A bare pnpm build mention is a phrase, not an invocation.",
      ].join("\n"),
    )
    await write("src/live/config.ts", "export const config = 1\n")
    await write("node_modules/.gitkeep", "")
    await gitStage()

    const report = await runComments()
    expect(report.findings).toEqual([])
    expect(report.disclosures.some((d) => /bare `pnpm X`/.test(d))).toBe(true)
    expect(report.disclosures.some((d) => /slash-joined phrase/.test(d))).toBe(true)
    expect(report.disclosures.some((d) => /host name/.test(d))).toBe(true)
  })

  it("collapses many comments citing one dead decision into one finding with example lines", async () => {
    await write("package.json", JSON.stringify({ name: "shape-demo" }))
    await write("DECISIONS.md", "# Decisions\n\n## D-001 Keep it small\n")
    await write(
      "src/app.ts",
      ["// D-009 first", "// D-009 second", "// D-009 third", "// D-009 fourth"].join("\n"),
    )
    await gitStage()

    const report = await runComments()
    expect(report.findings.length).toBe(1)
    expect(report.findings[0]?.claim).toContain("src/app.ts:1 cites D-009")
    // The first three occurrences are evidence; the fourth is summarized by the count below.
    expect(report.findings[0]?.evidence.length).toBeLessThanOrEqual(3)
  })

  it("skips test, fixture, and vendor files — counted, disclosed, out of scope", async () => {
    await write("package.json", JSON.stringify({ name: "shape-demo" }))
    await write("test/helper.spec.ts", "// See src/never/existed.ts\n")
    await write("src/app.test.ts", "// See src/also/missing.ts\n")
    await write("vendor/lib.ts", "// See src/vendor/missing.ts\n")
    await write("src/real.ts", "// Clean comment.\n")
    await gitStage()

    const report = await runComments()
    expect(report.findings).toEqual([])
    expect(report.disclosures.some((d) => /3 test\/fixture\/vendor file/.test(d))).toBe(true)
    expect(report.outOfScope).toEqual(["src/app.test.ts", "test/helper.spec.ts", "vendor/lib.ts"])
  })

  it("skips comments entirely when the repo is not git-tracked", async () => {
    await write("package.json", JSON.stringify({ name: "shape-demo" }))
    await write("src/app.ts", "// See src/gone/config.ts\n")

    const report = await runComments()
    expect(report.status).toBe("skipped")
    expect(report.findings).toEqual([])
  })
})

describe("offline by construction", () => {
  it("keeps the whole engine free of network calls (the product is a gate that needs no key)", async () => {
    const collect = async (p: string): Promise<string[]> => {
      const entries = await fs.readdir(p, { withFileTypes: true })
      const out: string[] = []
      for (const entry of entries) {
        const full = path.join(p, entry.name)
        if (entry.isDirectory()) out.push(...(await collect(full)))
        else if (entry.name.endsWith(".ts")) out.push(full)
      }
      return out
    }
    const files = await collect(fileURLToPath(new URL("../src", import.meta.url)))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const text = await fs.readFile(file, "utf8")
      expect(text, `${file} must not fetch`).not.toMatch(/\bfetch\s*\(/)
      expect(text, `${file} must not open sockets`).not.toMatch(/from\s+["']node:https?["']/)
    }
  })
})
