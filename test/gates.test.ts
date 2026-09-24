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

describe.skipIf(!existsSync(CLI))("etymd gates — shell discovery fails closed", () => {
  async function stub(command: string, body: string) {
    const rel = `.stub-bin/${command}`
    await write(rel, body)
    await fs.chmod(path.join(dir, rel), 0o755)
  }

  async function fixture() {
    await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await pExecFile("git", ["add", "."], { cwd: dir })
    await gates()
    // Only unrelated audit/content checks are stubbed; discovery runs in the generated hook.
    await stub("etymd", "#!/bin/sh\nexit 0\n")
    return {
      ...process.env,
      PATH: `${path.join(dir, ".stub-bin")}${path.delimiter}${process.env.PATH}`,
    }
  }

  async function recordShellcheck() {
    await stub(
      "shellcheck",
      `#!/usr/bin/env node
require("node:fs").appendFileSync("shellcheck.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n")
`,
    )
  }

  it.skipIf(!hasShellcheck)(
    "checks an extensionless script after a long tracked non-shell path",
    async () => {
      // BSD xargs -I caps each replaced argument at 255 bytes. Repeating this filename inside
      // sh -c exceeds that cap; the old trailing sort hid the failure and the later warning.
      await write(`docs/${"a".repeat(100)}.txt`, "ordinary text\n")
      await write("z-later", "#!/bin/sh\nnever_used=1\necho ok\n")
      const env = await fixture()

      await expect(
        pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env }),
      ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("SC2034") })
    },
  )

  it.skipIf(!hasShellcheck)(
    "a shell script whose own path crosses the BSD xargs -I cap stays in the set and blocks",
    async () => {
      // 125 bytes across two components, each under the filesystem's name-length limit. The
      // old -I{} discovery could not assemble a command line carrying a path this long, so the
      // script silently left the checked set — no error, no coverage line.
      const long = `docs/${"d".repeat(90)}/tool-${"t".repeat(24)}`
      await write(long, "#!/bin/sh\nnever_used=1\necho ok\n")
      const env = await fixture()

      const failure = await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env }).then(
        () => {
          throw new Error("expected the long-path script to block the push")
        },
        (error) => error,
      )
      expect(failure.code).toBe(1)
      // The checker's report names the file it read — set membership and the block in one fact.
      expect(failure.stdout).toContain("SC2034")
      expect(failure.stdout).toContain(long)
    },
  )

  it("passes whitespace, quotes and leading hyphens unchanged to the checker", async () => {
    const names = [
      "-leading",
      "tools/a 'single' \"double\" $(false) `false`",
      "tools/tab\tand\nline",
    ]
    for (const name of names) await write(name, "#!/bin/sh\necho ok\n")
    const env = await fixture()
    await recordShellcheck()

    await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    const calls = (await fs.readFile(path.join(dir, "shellcheck.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    // One invocation carries every name (was two: a blocking pass, then the same files again
    // for advice) — the verdict and the advice come from the same run now.
    expect(calls).toHaveLength(1)
    const only = calls[0] as string[]
    expect(only).toContain("style")
    expect(only).toContain("gcc")
    // ./ also prevents a filename from being interpreted as an option by the checker.
    expect(only.filter((arg) => arg.startsWith("./")).sort()).toEqual(
      [...names, "scripts/run"].map((name) => `./${name}`).sort(),
    )
  })

  it("PINNED: a tracked name carrying $(…) reaches the scan as data, never as code", async () => {
    // The defect this pins: the -I{} discovery interpolated each filename into a double-quoted
    // shell string, so one commit of a name like the one below executed on every push. The
    // marker makes execution observable — if the old shape ran, the payload fires with the
    // hook's cwd at the repo root and `pwned` lands beside these fixtures. The payload carries
    // no slash: a path separator cannot occur inside a filename, only inside what it executes.
    const hostile = "tool/sub$(touch pwned).sh"
    await write(hostile, "#!/bin/sh\necho ok\n")
    await write("tool/plain.sh", "#!/bin/sh\necho ok\n")
    await write("tool/not-a-script.txt", "no shebang here\n")
    const env = await fixture()
    // The shape itself, pinned on the generated bytes: every xargs INVOCATION is -I-free
    // (names move as arguments, never as replacements inside a quoted script). Prose that
    // names the retired shape is exempt — only command position counts.
    const hook = await prePush()
    const xargsLines = hook.split("\n").filter((line) => /^\s*xargs\b/.test(line))
    expect(xargsLines.length).toBeGreaterThan(0)
    for (const line of xargsLines) expect(line).not.toMatch(/-I/)
    await recordShellcheck()

    await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    expect(existsSync(path.join(dir, "pwned"))).toBe(false)
    const calls = (await fs.readFile(path.join(dir, "shellcheck.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    for (const args of calls) {
      // Byte-for-byte arrival: the substitution survives into the checked set instead of being
      // mangled by re-quoting, the plain script is beside it, and the non-script is not.
      expect(args).toContain(`./${hostile}`)
      expect(args).toContain("./tool/plain.sh")
      expect(args.some((arg) => arg.includes("not-a-script"))).toBe(false)
    }
  })

  // Each stub also asserts the message of the step it means to break: a failing `git` (or
  // `grep`) on PATH disturbs other hook steps too, so "the hook blocked" alone would not prove
  // the discovery step caused it. The head stub fails on the FIRST tracked file it is given, so
  // only the message prefix is pinned here — the unreadable-file test below pins the filename.
  it.each([
    ["git", "etymd: cannot enumerate tracked files for shellcheck"],
    ["head", "etymd: cannot read tracked file for shellcheck:"],
    ["grep", "etymd: shell script discovery failed"],
    ["xargs", "etymd: shell script discovery failed"],
  ])("blocks when %s fails during discovery, even after partial output", async (command, step) => {
    const env = await fixture()
    await recordShellcheck()
    await stub(
      command,
      `#!/bin/sh
${command === "git" ? "printf 'scripts/run\\0'" : command === "head" ? "printf '#!/bin/sh\\n'" : ":"}
echo "forced discovery failure" >&2
exit 23
`,
    )

    const run = pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("forced discovery failure"),
    })
    await expect(run).rejects.toMatchObject({
      stderr: expect.stringContaining(step),
    })
    expect(existsSync(path.join(dir, "shellcheck.jsonl"))).toBe(false)
  })

  it("blocks when a tracked regular file cannot be read, naming the file", async () => {
    const env = await fixture()
    await recordShellcheck()
    await fs.chmod(path.join(dir, "scripts/run"), 0o000)

    await expect(pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "etymd: cannot read tracked file for shellcheck: scripts/run",
      ),
    })
    expect(existsSync(path.join(dir, "shellcheck.jsonl"))).toBe(false)
  })

  it("discovers and checks its own classifier once the gates are tracked", async () => {
    // The classifier is the gate's most intricate code; kept inside a single-quoted sh -c
    // string, no linter ever saw it. As a shebanged tracked file it must land in the very
    // set it computes — the gate checks itself.
    const env = await fixture()
    await recordShellcheck()
    await pExecFile("git", ["add", ".githooks"], { cwd: dir })

    await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    const calls = (await fs.readFile(path.join(dir, "shellcheck.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      expect(args).toContain("./.githooks/discover-shell-scripts.sh")
      expect(args).toContain("./.githooks/pre-push")
    }
  })

  it("skips tracked paths with nothing readable behind them, and says so", async () => {
    // Deleted from the worktree while still tracked, plus a dangling symlink: neither is a
    // checking hazard that can lie, so neither blocks — but both are disclosed, never silent.
    await write("scripts/keep", "#!/bin/sh\necho ok\n")
    const env = await fixture()
    await recordShellcheck()
    await fs.unlink(path.join(dir, "scripts/run"))
    await fs.symlink("nowhere-at-all", path.join(dir, "dangling"))
    await pExecFile("git", ["add", "dangling"], { cwd: dir })

    const { stdout } = await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    expect(stdout).toContain("2 tracked path(s) with nothing readable behind them")
    const calls = (await fs.readFile(path.join(dir, "shellcheck.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    for (const args of calls) {
      expect(args).toContain("./scripts/keep")
      expect(args).not.toContain("./scripts/run")
      expect(args).not.toContain("./dangling")
    }
  })

  it("treats only the first line as a shebang, so docs embedding one are not scripts", async () => {
    // The shebang read is byte-bounded; a naive bound would let `#!/bin/sh` on a LATER line
    // of a document match the pattern and feed the whole document to the checker.
    await write("docs/example.md", "# Notes\n\n```sh\n#!/bin/sh\necho hi\n```\n")
    const env = await fixture()
    await recordShellcheck()

    await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    const calls = (await fs.readFile(path.join(dir, "shellcheck.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    for (const args of calls) {
      expect(args).not.toContain("./docs/example.md")
    }
  })

  it.skipIf(!hasShellcheck)(
    "one run is both verdict and advice: a warning blocks, a style note does not",
    async () => {
      await write("scripts/warn", "#!/bin/sh\nnever_used=1\necho ok\n")
      await write("scripts/style", '#!/bin/sh\nx=`date`\necho "$x"\n')
      const env = await fixture()

      const failure = await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env }).then(
        () => {
          throw new Error("expected the warning to block the push")
        },
        (error) => error,
      )
      expect(failure.code).toBe(1)
      // The blocking verdict names its finding; the advice block is never reached, so the
      // verdict is not reprinted below the bar it already enforced.
      expect(failure.stdout).toContain("SC2034")
      expect(failure.stdout).not.toContain("style/info (not blocking)")
    },
  )

  it.skipIf(!hasShellcheck)(
    "a style-only script passes the push and keeps its advice",
    async () => {
      await write("scripts/style", '#!/bin/sh\nx=`date`\necho "$x"\n')
      const env = await fixture()

      const { stdout } = await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
      expect(stdout).toContain("style/info (not blocking)")
      expect(stdout).toMatch(/SC\d{4}/)
    },
  )

  it("a shebang-only file with no trailing newline is still a script", async () => {
    // The first-line read must yield the partial line even without its newline — a
    // final-line-only shebang is a script like any other, not a silent coverage hole.
    await write("scripts/eol-less", "#!/bin/sh")
    const env = await fixture()
    await recordShellcheck()

    await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    const calls = (await fs.readFile(path.join(dir, "shellcheck.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toContain("./scripts/eol-less")
  })

  it("stays quiet when the tracked set has no shell scripts at all", async () => {
    // The step exists (the repo had a shell surface at gates time); an empty discovered set
    // prints nothing rather than inventing a verdict, and the checker is never invoked.
    const env = await fixture()
    await recordShellcheck()
    await fs.unlink(path.join(dir, "scripts/run"))
    await pExecFile("git", ["rm", "-q", "--cached", "scripts/run"], { cwd: dir })

    const { stdout } = await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    expect(stdout).not.toContain("shellcheck (")
    expect(stdout).not.toContain("style/info")
    expect(existsSync(path.join(dir, "shellcheck.jsonl"))).toBe(false)
  })
})

describe.skipIf(!existsSync(CLI))("etymd gates — zsh is outside shellcheck's reach", () => {
  it("the shebang scan hands only sh/bash/dash to shellcheck, and the hook says why", async () => {
    await write("package.json", JSON.stringify({ name: "zshy", private: true }, null, 2) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await write("tool/run.zsh", "#!/bin/zsh\necho hi\n")
    await pExecFile("git", ["add", "."], { cwd: dir })

    await gates()
    const hook = await prePush()
    const classifier = await fs.readFile(
      path.join(dir, ".githooks", "discover-shell-scripts.sh"),
      "utf8",
    )
    // The checked set: sh, bash, dash — zsh dropped from the character class. The pattern
    // lives in the classifier file now, which is the point: the hook delegates, the helper
    // classifies.
    expect(classifier).toContain("(ba|da)?sh")
    expect(classifier).not.toContain("(ba|da|z)?sh")
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

describe.skipIf(!existsSync(CLI))(
  "etymd gates — the generated hooks pass the checker they run",
  () => {
    it("PINNED: every generated hook is shellcheck-clean at warning", async () => {
      // A hook that gates on shellcheck must survive shellcheck itself. The specific trap this
      // pins: any comment whose first word is the checker's own name is parsed as a DIRECTIVE, so
      // prose explaining why a shell dialect is skipped can itself become a parse error — a
      // generated gate breaking the tool it exists to run.
      const hasShellcheck = await pExecFile("command", ["-v", "shellcheck"], { shell: true }).then(
        () => true,
        () => false,
      )
      if (!hasShellcheck) return

      await write("package.json", JSON.stringify({ name: "demo", private: true }, null, 2) + "\n")
      await write("AGENTS.md", "# AGENTS.md\n")
      await write("scripts/thing.sh", "#!/usr/bin/env sh\necho hi\n")
      await gates()

      const targets = [
        ".githooks/pre-commit",
        ".githooks/pre-push",
        ".githooks/commit-msg",
        ".githooks/discover-shell-scripts.sh",
      ].filter((rel) => existsSync(path.join(dir, rel)))
      expect(targets.length).toBeGreaterThan(0)

      const result = await pExecFile("shellcheck", ["-S", "warning", ...targets], {
        cwd: dir,
      }).then(
        () => ({ ok: true, out: "" }),
        (e: { stdout?: string; stderr?: string }) => ({
          ok: false,
          out: (e.stdout ?? "") + (e.stderr ?? ""),
        }),
      )
      expect(result.out).toBe("")
      expect(result.ok).toBe(true)
    })
  },
)

describe.skipIf(!existsSync(CLI))("etymd gates — a set-but-unusable override says so", () => {
  /** Deterministic doors: no ambient etymd, no shell surface — only the override under test. */
  async function bareFixture() {
    await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await pExecFile("git", ["add", "."], { cwd: dir })
    await gates()
  }

  it("pre-push: CONTENT_GATE naming a missing path is announced on stderr, not silent", async () => {
    await bareFixture()

    const env = { ...process.env, CONTENT_GATE: path.join(dir, "no-such-checker") }
    const { stderr } = await pExecFile("sh", [".githooks/pre-push"], { cwd: dir, env })
    expect(stderr).toContain("pre-push: CONTENT_GATE is set but not usable")
    expect(stderr).toContain("no-such-checker")
  })

  it("pre-commit and commit-msg announce their broken overrides too", async () => {
    await bareFixture()

    const staged = { ...process.env, CONTENT_GATE: path.join(dir, "no-such-checker") }
    const { stderr: pcErr } = await pExecFile("sh", [".githooks/pre-commit"], {
      cwd: dir,
      env: staged,
    })
    expect(pcErr).toContain("pre-commit: CONTENT_GATE is set but not usable")

    const msg = path.join(dir, "msg.txt")
    await fs.writeFile(msg, "chore: gate\n", "utf8")
    const msgEnv = { ...process.env, COMMIT_MSG_GATE: path.join(dir, "no-such-checker") }
    const { stderr: cmErr } = await pExecFile("sh", [".githooks/commit-msg", msg], {
      cwd: dir,
      env: msgEnv,
    })
    expect(cmErr).toContain("commit-msg: COMMIT_MSG_GATE is set but not usable")
  })

  it("an unset gate stays a silent no-op — the line is for misconfiguration, not absence", async () => {
    await bareFixture()

    const { stderr } = await pExecFile("sh", [".githooks/pre-push"], { cwd: dir })
    expect(stderr).not.toContain("is set but not usable")
  })
})

describe.skipIf(!existsSync(CLI))("etymd gates — the hooks README", () => {
  it("writes .githooks/README.md saying how git reaches the hooks", async () => {
    await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await pExecFile("git", ["add", "."], { cwd: dir })

    await gates()
    const readme = await fs.readFile(path.join(dir, ".githooks/README.md"), "utf8")
    expect(readme).toContain("core.hooksPath")
    expect(readme).toContain("machine-local")
    // Pack-owned and stamped, so regeneration can tell its own file from a stranger's.
    expect(readme).toContain("etymd:generated")
  })

  it("keeps a hand-written README — unstamped files are never clobbered", async () => {
    await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await write(".githooks/README.md", "# Our hooks\n")
    await pExecFile("git", ["add", "."], { cwd: dir })

    await gates()
    const readme = await fs.readFile(path.join(dir, ".githooks/README.md"), "utf8")
    expect(readme).toBe("# Our hooks\n")
  })
})
