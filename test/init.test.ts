import { execFile } from "node:child_process"
import { existsSync, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

const pExecFile = promisify(execFile)

// The built CLI (skipped when dist/ is absent; `npm ci` builds it via `prepare`, so CI has it).
const CLI = path.resolve(import.meta.dirname, "..", "dist", "cli.js")

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-init-"))
  await pExecFile("git", ["init", "-q"], { cwd: dir })
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

async function init(...args: string[]): Promise<string> {
  const { stdout } = await pExecFile("node", [CLI, "init", ...args], { cwd: dir })
  return stdout
}

describe.skipIf(!existsSync(CLI))("etymd init — the AGENTS.md scaffold is opt-in", () => {
  it("PINNED: -y in a repo without AGENTS.md creates only .etymd, no template contract", async () => {
    // Hooks pre-exist so the gates half of init has nothing to add — this isolates the scaffold.
    await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
    await write(".githooks/pre-commit", "#!/bin/sh\nexit 0\n")

    await init("-y")
    expect(existsSync(path.join(dir, ".etymd", "baseline.json"))).toBe(true)
    // The defect: a mechanical baseline-only rollout used to land unfilled contract prose
    // nobody reviewed — and the baseline then defended it.
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(false)
    expect(existsSync(path.join(dir, "CLAUDE.md"))).toBe(false)
  })

  it("-y --with-agents scaffolds the minimal contract where none exists", async () => {
    await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
    await write(".githooks/pre-commit", "#!/bin/sh\nexit 0\n")

    await init("-y", "--with-agents")
    expect(existsSync(path.join(dir, ".etymd", "baseline.json"))).toBe(true)
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(true)
  })

  it("the agents scaffold carries its CLAUDE.md pointer — one import line, nothing else to obey", async () => {
    // Claude Code auto-discovers CLAUDE.md and never loads AGENTS.md; the scaffold that writes
    // the contract must make it visible there, or `fleet add` refuses what init produced.
    await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
    await write(".githooks/pre-commit", "#!/bin/sh\nexit 0\n")

    await init("-y", "--with-agents")
    const pointer = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8")
    expect(/^\s*@AGENTS\.md\s*$/m.test(pointer)).toBe(true)
    expect(pointer).toContain("edit `AGENTS.md`, not this file")
  })

  it("keeps an existing CLAUDE.md when scaffolding AGENTS.md — never overwrites", async () => {
    await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
    await write(".githooks/pre-commit", "#!/bin/sh\nexit 0\n")
    await write("CLAUDE.md", "# bespoke Claude instructions, kept\n")

    const out = await init("-y", "--with-agents")
    expect(await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8")).toBe(
      "# bespoke Claude instructions, kept\n",
    )
    // Kept, and it hides the AGENTS.md just written — said now, not first at `fleet add`.
    expect(out).toContain("CLAUDE.md kept, but it does not import AGENTS.md")
  })

  it("a kept CLAUDE.md that already imports AGENTS.md draws no warning", async () => {
    await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
    await write(".githooks/pre-commit", "#!/bin/sh\nexit 0\n")
    await write("CLAUDE.md", "# CLAUDE.md\n\n@AGENTS.md\n")

    expect(await init("-y", "--with-agents")).not.toContain("does not import AGENTS.md")
  })
})
