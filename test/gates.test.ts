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
})

describe.skipIf(!existsSync(CLI))(
  "etymd gates — which binary the content screen resolves to",
  () => {
    /** A foreign CLI built to the path the old heuristic guessed at. Rejects `screen`, as they do. */
    async function foreignCliAt(rel: string) {
      await write(rel, "#!/usr/bin/env sh\necho \"error: unknown command 'screen'\" >&2\nexit 1\n")
      await fs.chmod(path.join(dir, rel), 0o755)
    }

    /** An ambient etymd that reports what it was asked to do, so the hook's call is observable. */
    async function stubEtymdOnPath(): Promise<string> {
      const bin = path.join(dir, ".stub-bin")
      await fs.mkdir(bin, { recursive: true })
      const exe = path.join(bin, "etymd")
      await fs.writeFile(exe, '#!/usr/bin/env sh\necho "STUB-ETYMD $*"\nexit 0\n', "utf8")
      await fs.chmod(exe, 0o755)
      return bin
    }

    it("PINNED: a repo that builds its own dist/cli.js never has it chosen as the screener", async () => {
      // The defect this pins: `[ -x ./dist/cli.js ]` was emitted into EVERY repo, so any project
      // building a CLI to that ordinary path had its own binary invoked as the content screen —
      // blocking every commit, and silently skipping the whole-tree pass on push.
      await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
      await write("AGENTS.md", "# AGENTS.md\n")
      await foreignCliAt("dist/cli.js")

      await gates()

      // Every door that resolves a screener, not just the one the failure was noticed at.
      for (const rel of [".githooks/pre-commit", ".githooks/pre-push"]) {
        const hook = await fs.readFile(path.join(dir, rel), "utf8")
        expect(hook, rel).toContain('GATE="${CONTENT_GATE:-$(command -v etymd || true)}"')
        expect(hook, rel).not.toContain("dist/cli.js")
      }
    })

    it("PINNED: the screen runs through a real commit, with no CONTENT_GATE override", async () => {
      // Reading the hook is not enough — the reported symptom was a commit that could not be made.
      await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
      await write("AGENTS.md", "# AGENTS.md\n")
      await foreignCliAt("dist/cli.js")
      await gates()

      const bin = await stubEtymdOnPath()
      const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      }
      await pExecFile("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir })
      await pExecFile("git", ["add", "AGENTS.md", "package.json"], { cwd: dir, env })

      const { stdout, stderr } = await pExecFile("git", ["commit", "-m", "chore: gate"], {
        cwd: dir,
        env,
      })
      const out = stdout + stderr
      // The ambient etymd screened the staged bytes…
      expect(out).toContain("STUB-ETYMD screen --staged")
      // …and the repo's own binary was never reached.
      expect(out).not.toContain("unknown command")
    })

    it("keeps the dev-build arm in the screener's OWN repo — the case the heuristic existed for", async () => {
      // A repo developing the screener must gate on its unreleased build, or its hooks enforce the
      // last published behaviour against a tree that has moved past it. Keyed on the manifest name
      // at generation time, so it can reach no other repo.
      await write("package.json", JSON.stringify({ name: "etymd", private: true }, null, 2) + "\n")
      await write("AGENTS.md", "# AGENTS.md\n")

      await gates()
      const hook = await fs.readFile(path.join(dir, ".githooks", "pre-commit"), "utf8")
      expect(hook).toContain("[ -x ./dist/cli.js ]")
    })

    it("a directory merely NAMED etymd, with no manifest, gets no dev-build arm", async () => {
      // `facts.name` falls back to the directory basename, which is a coincidence, not an identity.
      const named = path.join(dir, "etymd")
      await fs.mkdir(named, { recursive: true })
      await pExecFile("git", ["init", "-q"], { cwd: named })
      await fs.writeFile(path.join(named, "AGENTS.md"), "# AGENTS.md\n", "utf8")

      await pExecFile("node", [CLI, "gates", "-y"], { cwd: named })
      const hook = await fs.readFile(path.join(named, ".githooks", "pre-commit"), "utf8")
      expect(hook).not.toContain("dist/cli.js")
    })
  },
)

describe.skipIf(!existsSync(CLI))(
  "etymd gates — a screen door that explains its own failure",
  () => {
    it("PINNED: a runner that does not understand `screen` gets a self-explaining line, not a bare error", async () => {
      // `screen` needs etymd 0.11+. Against an older one the runner answers with its own
      // "unknown command" and nothing else — no cause, no way out, at the moment a commit is
      // blocked. That is the same unexplained-gate shape the pack exists to prevent.
      await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
      await write("AGENTS.md", "# AGENTS.md\n")
      await gates()

      const notAScreener = path.join(dir, "old-etymd")
      await fs.writeFile(
        notAScreener,
        "#!/usr/bin/env sh\necho \"error: unknown command 'screen'\" >&2\nexit 1\n",
        "utf8",
      )
      await fs.chmod(notAScreener, 0o755)

      const env = {
        ...process.env,
        CONTENT_GATE: notAScreener,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      }
      await pExecFile("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir })
      await pExecFile("git", ["add", "AGENTS.md", "package.json"], { cwd: dir, env })

      const failure = await pExecFile("git", ["commit", "-m", "chore: gate"], {
        cwd: dir,
        env,
      }).then(
        () => null,
        (e: { stdout?: string; stderr?: string }) => e,
      )
      // Still blocks — the hint explains a refusal, it never softens one.
      expect(failure).not.toBeNull()
      const out = (failure?.stdout ?? "") + (failure?.stderr ?? "")
      expect(out).toContain("does not understand 'screen'")
      expect(out).toContain("etymd 0.11+")
      expect(out).toContain("CONTENT_GATE")
    })

    it("PINNED: a working screener never pays for the probe", async () => {
      // The probe is post-failure only. A clean commit must not invoke the runner a second time.
      await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
      await write("AGENTS.md", "# AGENTS.md\n")
      await gates()

      const counter = path.join(dir, "counted-etymd")
      await fs.writeFile(
        counter,
        `#!/usr/bin/env sh\necho "CALL $*" >> "${path.join(dir, "calls.log")}"\nexit 0\n`,
        "utf8",
      )
      await fs.chmod(counter, 0o755)

      const env = {
        ...process.env,
        CONTENT_GATE: counter,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      }
      await pExecFile("git", ["config", "core.hooksPath", ".githooks"], { cwd: dir })
      await pExecFile("git", ["add", "AGENTS.md", "package.json"], { cwd: dir, env })
      await pExecFile("git", ["commit", "-m", "chore: gate"], { cwd: dir, env })

      const log = await fs.readFile(path.join(dir, "calls.log"), "utf8")
      expect(log).toContain("CALL screen --staged")
      expect(log).not.toContain("--help")
    })
  },
)
