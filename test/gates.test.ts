import { execFile, execSync } from "node:child_process"
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-gates-"))
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

async function gates(): Promise<string> {
  const { stdout } = await pExecFile("node", [CLI, "gates", "-y"], { cwd: dir })
  return stdout
}

async function prePush(): Promise<string> {
  return fs.readFile(path.join(dir, ".githooks", "pre-push"), "utf8")
}

describe.skipIf(!existsSync(CLI))("etymd gates — the written tier is derived and disclosed", () => {
  it("PINNED: a repo where no risk-tier rule can fire never gets a gate that cannot fail", async () => {
    // Documents only: no manifest to contradict a script claim, no state doc to fall behind.
    // `--fail-on risk` here would exit 0 on every push while reading as assurance.
    await write("AGENTS.md", "# AGENTS.md\n\nRead the design notes in `design/`.\n")

    const out = await gates()
    expect(await prePush()).toContain("--fail-on gap")
    expect(await prePush()).not.toContain("--fail-on risk")
    // Silent is the one option off the table: the output says the tier moved, and why.
    expect(out).toContain("no risk-tier finding can fire in this repo")
    // …and names the durable home for the tier, which is where the fix belongs.
    expect(out).toContain("gates.failOn")
  })

  it("leaves the tier at risk where a risk-tier rule is reachable", async () => {
    await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")

    const out = await gates()
    expect(await prePush()).toContain("--fail-on risk")
    expect(out).not.toContain("no risk-tier finding can fire")
  })

  it("PINNED: a recorded gates.failOn survives regeneration, and the output says where it came from", async () => {
    // The failure being fixed: a hand-chosen tier reverted by a generated-file change nobody
    // reads as policy. Config is a decision; the derivation may only choose between defaults.
    await write("AGENTS.md", "# AGENTS.md\n")
    await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
    await write(
      ".etymd/config.json",
      JSON.stringify({ gates: { failOn: "polish" } }, null, 2) + "\n",
    )

    const out = await gates()
    expect(await prePush()).toContain("--fail-on polish")
    expect(out).toContain(path.join(".etymd", "config.json"))
  })

  it("PINNED: a configured test command runs inside the GIT_* scrub, never the raw hook environment", async () => {
    // The class: git exports GIT_DIR/GIT_WORK_TREE/… to every hook, a child git inherits them
    // and ignores its cwd, and a hook-run suite that builds fixture repositories would operate
    // on the REAL repo. The step must be routed through the scrub, not merely accompanied by it.
    await write("AGENTS.md", "# AGENTS.md\n")
    await write(
      "package.json",
      JSON.stringify({ name: "demo", private: true, scripts: { test: "vitest run" } }, null, 2) +
        "\n",
    )
    await write(
      ".etymd/config.json",
      JSON.stringify({ gates: { commands: ["test"] } }, null, 2) + "\n",
    )

    await gates()
    const hook = await prePush()
    expect(hook).toContain("run_gate npm run test || exit 1")
    // Every exported GIT_* name is stripped, never a fixed list — git adds names over time.
    expect(hook).toContain("grep -o '^GIT_[A-Za-z0-9_]*'")
    // The companion note names the hazard, so a hand-written `.local` guard can do the same.
    expect(hook).toContain("GIT_* names")
  })

  it("the emitted scrub actually blinds a child git to the exported GIT_DIR", async () => {
    // A text-level assertion passes a broken scrub line; only running it proves the wrap works.
    const outer = path.join(dir, "outer")
    const inner = path.join(dir, "inner")
    for (const repo of [outer, inner]) {
      await fs.mkdir(repo, { recursive: true })
      await pExecFile("git", ["init", "-q"], { cwd: repo })
    }
    // Control: with GIT_DIR exported (the hook environment), the child git ignores its cwd —
    // this is the defect class the scrub exists to break.
    const dirty = await pExecFile("sh", ["-c", "cd inner && git rev-parse --git-dir"], {
      cwd: dir,
      env: { ...process.env, GIT_DIR: path.join(outer, ".git") },
    })
    expect(path.resolve(dir, dirty.stdout.trim())).toBe(path.join(outer, ".git"))
    // Scrubbed: the same environment, wrapped the way the generated hook wraps it — the child
    // resolves the repository from its working directory again.
    const clean = await pExecFile(
      "sh",
      [
        "-c",
        "cd inner && env $(env | grep -o '^GIT_[A-Za-z0-9_]*' | sed 's/^/-u /') git rev-parse --git-dir",
      ],
      { cwd: dir, env: { ...process.env, GIT_DIR: path.join(outer, ".git") } },
    )
    expect(path.resolve(inner, clean.stdout.trim())).toBe(path.join(inner, ".git"))
  })
})

// Behavioral runs below prove blocking/clean against the REAL checker — only where it exists.
let hasShellcheck = false
try {
  execSync("command -v shellcheck", { stdio: "ignore" })
  hasShellcheck = true
} catch {
  /* not on PATH — the hook's own absent-checker branch covers that case */
}

describe.skipIf(!existsSync(CLI))("etymd gates — zsh is outside shellcheck's reach", () => {
  it("the shebang scan hands only sh/bash/dash to shellcheck, and the hook says why", async () => {
    await write("package.json", JSON.stringify({ name: "zshy", private: true }, null, 2) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await write("tool/run.zsh", "#!/bin/zsh\necho hi\n")
    await pExecFile("git", ["add", "."], { cwd: dir })

    await gates()
    const hook = await prePush()
    // The checked set: sh, bash, dash — zsh dropped from the character class.
    expect(hook).toContain("(ba|da)?sh")
    expect(hook).not.toContain("(ba|da|z)?sh")
    // The exclusion is a disclosed skip, not silent absence of coverage.
    expect(hook).toContain("SC1071")
    expect(hook).toContain("zsh script(s) excluded")
  })

  it.skipIf(!hasShellcheck)(
    "PINNED: a repo whose surface is zsh pushes clean through the fresh hook",
    async () => {
      await write("package.json", JSON.stringify({ name: "zshy", private: true }, null, 2) + "\n")
      await write("AGENTS.md", "# AGENTS.md\n")
      await write("tool/run.zsh", "#!/bin/zsh\necho hi\n")
      await pExecFile("git", ["add", "."], { cwd: dir })

      await gates()
      // Running the generated hook directly is what a push executes. Before the fix this died
      // inside shellcheck on SC1071 — a parser error, not a finding.
      const { stdout } = await pExecFile("sh", [path.join(dir, ".githooks", "pre-push")], {
        cwd: dir,
      })
      expect(stdout).toContain("zsh script(s) excluded")
    },
  )

  it.skipIf(!hasShellcheck)("a bash script with a real warning still blocks the push", async () => {
    await write("package.json", JSON.stringify({ name: "bashy", private: true }, null, 2) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await write("tool/do.sh", "#!/bin/bash\nnever_used=1\necho ok\n")
    await pExecFile("git", ["add", "."], { cwd: dir })

    await gates()
    await expect(
      pExecFile("sh", [path.join(dir, ".githooks", "pre-push")], { cwd: dir }),
    ).rejects.toThrow()
  })
})
