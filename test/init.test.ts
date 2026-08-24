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
  })

  it("-y --with-agents scaffolds the minimal contract where none exists", async () => {
    await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
    await write(".githooks/pre-commit", "#!/bin/sh\nexit 0\n")

    await init("-y", "--with-agents")
    expect(existsSync(path.join(dir, ".etymd", "baseline.json"))).toBe(true)
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(true)
  })
})
