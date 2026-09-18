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

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
}

/** Commit the fixture's files, so the gate has real commits to be pointed at. */
async function commitAll(message: string) {
  await pExecFile("git", ["add", "."], { cwd: dir })
  await pExecFile("git", ["commit", "-q", "-m", message], { cwd: dir, env: GIT_ENV })
}

async function revParse(rev: string): Promise<string> {
  const { stdout } = await pExecFile("git", ["rev-parse", rev], { cwd: dir })
  return stdout.trim()
}

/** A refs line for updating `branch` from `base` to `head` — one pushed ref, as git reports it. */
const update = (branch: string, head: string, base: string) =>
  `refs/heads/${branch} ${head} refs/heads/${branch} ${base}`

const ZERO = "0".repeat(40)

/**
 * Run the generated pre-push the way git does: one "<local ref> <local sha> <remote ref>
 * <remote sha>" line per pushed ref, on stdin.
 */
async function runPrePush(env: NodeJS.ProcessEnv, ...refLines: string[]) {
  const refsFile = path.join(dir, ".pushed-refs")
  await fs.writeFile(refsFile, refLines.join("\n") + (refLines.length ? "\n" : ""), "utf8")
  return pExecFile("sh", ["-c", '".githooks/pre-push" < "$1"', "sh", refsFile], { cwd: dir, env })
}

/** The base every fixture builds on: a manifest, an instruction file, one commit for HEAD. */
async function baseRepo() {
  await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
  await write("AGENTS.md", "# AGENTS.md\n")
  await commitAll("chore: base")
}

async function stub(command: string, body: string) {
  const rel = `.stub-bin/${command}`
  await write(rel, body)
  await fs.chmod(path.join(dir, rel), 0o755)
}

/** Only the unrelated audit/content checks are stubbed; discovery runs in the generated hook. */
async function stubEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  await stub("etymd", "#!/bin/sh\nexit 0\n")
  return {
    ...process.env,
    ...extra,
    PATH: `${path.join(dir, ".stub-bin")}${path.delimiter}${process.env.PATH}`,
  }
}

/** A recording checker stand-in. The hook runs it inside the materialised tree, so the log
 * path travels by environment, never by relative filename. */
async function recordShellcheck() {
  await stub(
    "shellcheck",
    `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.ETYMD_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n")
`,
  )
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
  it.skipIf(!hasShellcheck)(
    "checks an extensionless script after a long tracked non-shell path",
    async () => {
      // BSD xargs -I caps each replaced argument at 255 bytes. Repeating this filename inside
      // sh -c exceeds that cap; the old trailing sort hid the failure and the later warning.
      await baseRepo()
      await write(`docs/${"a".repeat(100)}.txt`, "ordinary text\n")
      await write("z-later", "#!/bin/sh\nnever_used=1\necho ok\n")
      await commitAll("chore: scripts")
      await gates()
      const env = await stubEnv()
      const base = await revParse("HEAD~1")
      const head = await revParse("HEAD")

      await expect(runPrePush(env, update("main", head, base))).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("SC2034"),
      })
    },
  )

  it("passes whitespace, quotes and leading hyphens unchanged to both checker passes", async () => {
    const names = [
      "-leading",
      "tools/a 'single' \"double\" $(false) `false`",
      "tools/tab\tand\nline",
    ]
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    for (const name of names) await write(name, "#!/bin/sh\necho ok\n")
    await commitAll("chore: scripts")
    await gates()
    await recordShellcheck()
    const log = path.join(dir, "shellcheck.jsonl")
    const env = await stubEnv({ ETYMD_RECORD: log })
    const base = await revParse("HEAD~1")
    const head = await revParse("HEAD")

    await runPrePush(env, update("main", head, base))
    const calls = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(2)
    for (const args of calls) {
      // ./ also prevents a filename from being interpreted as an option by the checker.
      expect(args.filter((arg) => arg.startsWith("./")).sort()).toEqual(
        [...names, "scripts/run"].map((name) => `./${name}`).sort(),
      )
    }
    expect(calls[0]).toContain("warning")
    expect(calls[1]).toContain("style")
  })

  it.each(["git", "head", "grep", "xargs"])(
    "blocks when %s fails during discovery, even after partial output",
    async (command) => {
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: scripts")
      await gates()
      await recordShellcheck()
      await stub(
        command,
        `#!/bin/sh
${command === "head" ? "printf '#!/bin/sh\\n'" : ":"}
echo "forced discovery failure" >&2
exit 23
`,
      )
      const env = await stubEnv()
      const base = await revParse("HEAD~1")
      const head = await revParse("HEAD")

      await expect(runPrePush(env, update("main", head, base))).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("forced discovery failure"),
      })
      expect(existsSync(path.join(dir, "shellcheck.jsonl"))).toBe(false)
    },
  )

  it("PINNED: the pushed commit is the read — a deleted working-tree copy neither dodges the gate nor blocks it", async () => {
    // The 2026-09-15 shape inverted: the working tree was never the right read. Deleting the
    // only working-tree copy of a script must not skip the commit's copy — and must not break
    // an unrelated push the way a tree-reading gate did.
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await commitAll("chore: scripts")
    await gates()
    await recordShellcheck()
    const log = path.join(dir, "shellcheck.jsonl")
    const env = await stubEnv({ ETYMD_RECORD: log })
    const base = await revParse("HEAD~1")
    const head = await revParse("HEAD")
    await fs.unlink(path.join(dir, "scripts/run"))

    await runPrePush(env, update("main", head, base))
    const calls = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toContain("./scripts/run")
  })
})

describe.skipIf(!existsSync(CLI))(
  "etymd gates — the range being pushed, not the tree or the tip",
  () => {
    it.skipIf(!hasShellcheck)(
      "PINNED: a bad middle commit under a clean tip refuses the push",
      async () => {
        // The failure being fixed: a tip-only read passed exactly this push — bad script
        // committed, then fixed — and the bad commit landed on the remote. Every commit in
        // the range is materialised and checked, so the middle commit refuses the push even
        // though HEAD is clean.
        await baseRepo()
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: bad script")
        await write("tool/do.sh", "#!/bin/sh\necho ok\n")
        await commitAll("chore: fix it")
        await gates()
        const env = await stubEnv()
        const base = await revParse("HEAD~2")
        const head = await revParse("HEAD")

        await expect(runPrePush(env, update("main", head, base))).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining("SC2034"),
        })
      },
    )

    it.skipIf(!hasShellcheck)(
      "an all-zero remote sha (a new branch) checks every commit no remote already has",
      async () => {
        await baseRepo()
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: bad script")
        await gates()
        const env = await stubEnv()
        const head = await revParse("HEAD")

        // No remote exists in the fixture, so --not --remotes negates nothing: the whole
        // young history is the push, bad commit included.
        await expect(
          runPrePush(env, `refs/heads/topic ${head} refs/heads/topic ${ZERO}`),
        ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("SC2034") })
      },
    )

    it.skipIf(!hasShellcheck)("a delete-only push has nothing to check and says so", async () => {
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: scripts")
      await gates()
      const env = await stubEnv()
      const head = await revParse("HEAD")

      const { stdout } = await runPrePush(env, `refs/heads/gone ${ZERO} refs/heads/gone ${head}`)
      expect(stdout).toContain("no commit in the pushed refs")
    })

    it.skipIf(!hasShellcheck)(
      "an empty range (nothing new to push) is clean and says so",
      async () => {
        await baseRepo()
        await write("scripts/run", "#!/bin/sh\necho ok\n")
        await commitAll("chore: scripts")
        await gates()
        const env = await stubEnv()
        const head = await revParse("HEAD")

        const { stdout } = await runPrePush(env, update("main", head, head))
        expect(stdout).toContain("nothing to check")
      },
    )

    it("PINNED: commits that share one tree are materialised and checked once", async () => {
      // The blow-up being fixed: merge/squash histories push many commits over few trees, and
      // a per-commit read made each of them pay a full-tree extraction and checker run. The
      // bytes under judgment are the tree's — identical trees are certified identically, once.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      // An empty commit on top carries the SAME tree: two commits in the range, one tree.
      await pExecFile("git", ["commit", "-q", "--allow-empty", "-m", "chore: empty on top"], {
        cwd: dir,
        env: GIT_ENV,
      })
      await gates()
      await recordShellcheck()
      const log = path.join(dir, "shellcheck.jsonl")
      const env = await stubEnv({ ETYMD_RECORD: log })
      const base = await revParse("HEAD~2")
      const head = await revParse("HEAD")

      const { stdout } = await runPrePush(env, update("main", head, base))
      expect(stdout).toContain("2 commit(s) in the push, 1 distinct tree(s) to check")
      const calls = (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      // Two passes (blocking + advice) for the ONE shared tree — not doubled per commit.
      expect(calls).toHaveLength(2)
      for (const args of calls) expect(args).toContain("./scripts/run")
    })

    it("commits with distinct trees are each checked — the dedupe never skips a different tree", async () => {
      await baseRepo()
      await write("scripts/a", "#!/bin/sh\necho a\n")
      await commitAll("chore: a")
      await write("scripts/b", "#!/bin/sh\necho b\n")
      await commitAll("chore: b")
      await gates()
      await recordShellcheck()
      const log = path.join(dir, "shellcheck.jsonl")
      const env = await stubEnv({ ETYMD_RECORD: log })
      const base = await revParse("HEAD~2")
      const head = await revParse("HEAD")

      const { stdout } = await runPrePush(env, update("main", head, base))
      expect(stdout).toContain("2 commit(s) in the push, 2 distinct tree(s) to check")
      const calls = (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      // Two passes per tree, two distinct trees.
      expect(calls).toHaveLength(4)
    })
  },
)

/** A second repository's HEAD, to plant as a submodule gitlink — a path ls-tree lists and the
 * archive never carries. */
async function gitlinkSha(): Promise<string> {
  const sub = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-gates-sub-"))
  try {
    await pExecFile("git", ["init", "-q"], { cwd: sub })
    await fs.writeFile(path.join(sub, "f.txt"), "x\n", "utf8")
    await pExecFile("git", ["add", "."], { cwd: sub })
    await pExecFile("git", ["commit", "-q", "-m", "sub"], { cwd: sub, env: GIT_ENV })
    const { stdout } = await pExecFile("git", ["rev-parse", "HEAD"], { cwd: sub })
    return stdout.trim()
  } finally {
    await fs.rm(sub, { recursive: true, force: true })
  }
}

describe.skipIf(!existsSync(CLI))(
  "etymd gates — archive gaps are disclosed skips, never refused pushes",
  () => {
    it("PINNED: export-ignore, a submodule gitlink and a dangling symlink are counted, not bricks", async () => {
      // The brick being fixed: every one of these paths is listed by ls-tree and absent from
      // the extract, and the discovery read hard-failed on the first one — refusing EVERY
      // push of any repo with one such path. They are bytes this read cannot see, so they are
      // counted and disclosed; the readable scripts around them are still checked.
      await baseRepo()
      await write(".gitattributes", "docs/internal.md export-ignore\n")
      await write("docs/internal.md", "internal notes\n")
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await fs.symlink("no-such-target", path.join(dir, "dangling.sh"))
      await commitAll("chore: gaps and a good script")
      // The gitlink goes into the index directly: `git add .` would drop a path that has no
      // working-tree counterpart, so it is planted after the last add and committed as-is.
      await pExecFile(
        "git",
        ["update-index", "--add", "--cacheinfo", `160000,${await gitlinkSha()},vendor/sub`],
        { cwd: dir },
      )
      await pExecFile("git", ["commit", "-q", "-m", "chore: gitlink"], { cwd: dir, env: GIT_ENV })
      await gates()
      await recordShellcheck()
      const log = path.join(dir, "shellcheck.jsonl")
      const env = await stubEnv({ ETYMD_RECORD: log })
      const base = await revParse("HEAD~2")
      const head = await revParse("HEAD")

      const { stdout } = await runPrePush(env, update("main", head, base))
      expect(stdout).toContain(
        "2 tracked path(s) not regular files in the extract — export-ignore, submodule gitlink, or dangling link; not read, not checked",
      )
      const calls = (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      expect(calls.length).toBeGreaterThan(0)
      for (const args of calls) expect(args).toContain("./scripts/run")
    })

    it.skipIf(!hasShellcheck)(
      "PINNED: an export-ignored file in the same tree does not soften a refused script",
      async () => {
        await baseRepo()
        await write(".gitattributes", "docs/internal.md export-ignore\n")
        await write("docs/internal.md", "internal notes\n")
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: ignored doc + bad script")
        await gates()
        const env = await stubEnv()
        const base = await revParse("HEAD~1")
        const head = await revParse("HEAD")

        await expect(runPrePush(env, update("main", head, base))).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining("SC2034"),
        })
      },
    )

    it.skipIf(!hasShellcheck)(
      "enumeration and discovery failures speak with the same ✗ shellcheck: prefix",
      async () => {
        // Someone debugging a refused push at night reads the prefix as the failing tool: a
        // bare `etymd:` sends them debugging the pack generator instead of the checker.
        await baseRepo()
        await write("scripts/run", "#!/bin/sh\necho ok\n")
        await commitAll("chore: scripts")
        await gates()
        const env = await stubEnv()
        const head = await revParse("HEAD")
        await stub("git", "#!/bin/sh\nexit 23\n")

        await expect(runPrePush(env, update("main", head, head))).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(
            "✗ shellcheck: could not enumerate the commits being pushed",
          ),
        })
        // The other two refusals in the block are pinned on the generated text — reaching
        // them behaviorally means breaking git itself, which the stubbed run above already
        // does for the first.
        const hook = await prePush()
        expect(hook).toContain('echo "✗ shellcheck: cannot enumerate the tree')
        expect(hook).toContain('echo "✗ shellcheck: script discovery failed')
        expect(hook).not.toContain("etymd: shell script discovery")
        expect(hook).not.toContain("etymd: cannot enumerate")
        expect(hook).not.toContain("etymd: could not enumerate")
      },
    )
  },
)

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
      await baseRepo()
      await write("tool/run.zsh", "#!/bin/zsh\necho hi\n")
      await commitAll("chore: zsh tool")
      await gates()
      const env = await stubEnv()
      const base = await revParse("HEAD~1")
      const head = await revParse("HEAD")
      // Running the generated hook with git's ref lines on stdin is what a push executes.
      // Before the fix this died inside shellcheck on SC1071 — a parser error, not a finding.
      const { stdout } = await runPrePush(env, update("main", head, base))
      expect(stdout).toContain("zsh script(s) excluded")
    },
  )

  it.skipIf(!hasShellcheck)("a bash script with a real warning still blocks the push", async () => {
    await baseRepo()
    await write("tool/do.sh", "#!/bin/bash\nnever_used=1\necho ok\n")
    await commitAll("chore: bash tool")
    await gates()
    const env = await stubEnv()
    const base = await revParse("HEAD~1")
    const head = await revParse("HEAD")
    await expect(runPrePush(env, update("main", head, base))).rejects.toThrow()
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

      const targets = [".githooks/pre-commit", ".githooks/pre-push", ".githooks/commit-msg"].filter(
        (rel) => existsSync(path.join(dir, rel)),
      )
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
