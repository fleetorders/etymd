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

/** The discovery fixture: files the test wrote, plus a manifest, an instruction file, one
 * script, and fresh gates. Nothing is committed yet — `commitFixture` does that, once. */
async function fixture(): Promise<NodeJS.ProcessEnv> {
  await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
  await write("AGENTS.md", "# AGENTS.md\n")
  await write("scripts/run", "#!/bin/sh\necho ok\n")
  await pExecFile("git", ["add", "."], { cwd: dir })
  await gates()
  return stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })
}

/** Commit everything as ONE commit and return the refs line that pushes it as a new branch.
 * The hook reads commits, not the working tree, so a fixture counts only once committed.
 * --no-verify: the generated pre-commit is not what these tests exercise. `stage: false` commits
 * the index as the test left it — `git add .` would drop an entry with no worktree file behind
 * it, such as a hand-staged submodule. */
async function commitFixture({ stage = true } = {}): Promise<string> {
  if (stage) await pExecFile("git", ["add", "."], { cwd: dir })
  await pExecFile("git", ["commit", "-q", "--no-verify", "-m", "chore: fixture"], {
    cwd: dir,
    env: GIT_ENV,
  })
  return update("main", await revParse("HEAD"), ZERO)
}

/** Every argument list the recording checker received, one per invocation. */
async function recorded(): Promise<string[][]> {
  return (await fs.readFile(path.join(dir, "shellcheck.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
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

  it.skipIf(!hasShellcheck)(
    "a shell script whose own path crosses the BSD xargs -I cap stays in the set and blocks",
    async () => {
      // 125 bytes across two components, each under the filesystem's name-length limit. The
      // old -I{} discovery could not assemble a command line carrying a path this long, so the
      // script silently left the checked set — no error, no coverage line.
      const long = `docs/${"d".repeat(90)}/tool-${"t".repeat(24)}`
      await write(long, "#!/bin/sh\nnever_used=1\necho ok\n")
      const env = await fixture()
      const pushed = await commitFixture()

      const failure = await runPrePush(env, pushed).then(
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
    const xargsLines = hook
      .split("\n")
      .filter((line) => /^\s*(\( cd "\$tree" && )?xargs\b/.test(line))
    expect(xargsLines.length).toBeGreaterThan(0)
    for (const line of xargsLines) expect(line).not.toMatch(/-I/)
    await recordShellcheck()
    const pushed = await commitFixture()

    await runPrePush(env, pushed)
    expect(existsSync(path.join(dir, "pwned"))).toBe(false)
    for (const args of await recorded()) {
      // Byte-for-byte arrival: the substitution survives into the checked set instead of being
      // mangled by re-quoting, the plain script is beside it, and the non-script is not.
      expect(args).toContain(`./${hostile}`)
      expect(args).toContain("./tool/plain.sh")
      expect(args.some((arg) => arg.includes("not-a-script"))).toBe(false)
    }
  })

  // Each stub also asserts the message of the step it means to break: a failing `git` (or
  // `grep`) on PATH disturbs other hook steps too, so "the hook blocked" alone would not prove
  // the discovery step caused it. The stubs go on PATH only after the fixture is committed, so
  // they break the push, never the setup. ETYMD_RECORD stays set: a regression that reached
  // the checker after partial discovery would write the log, not throw before it.
  it.each([
    ["git", "etymd: could not enumerate the commits being pushed for shellcheck"],
    ["head", "etymd: cannot read tracked file for shellcheck:"],
    ["grep", "etymd: shell script discovery failed"],
    ["xargs", "etymd: shell script discovery failed"],
  ])("blocks when %s fails during discovery, even after partial output", async (command, step) => {
    const env = await fixture()
    await recordShellcheck()
    const pushed = await commitFixture()
    await stub(
      command,
      `#!/bin/sh
${command === "git" ? "printf 'scripts/run\\0'" : command === "head" ? "printf '#!/bin/sh\\n'" : ":"}
echo "forced discovery failure" >&2
exit 23
`,
    )

    const run = runPrePush(env, pushed)
    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("forced discovery failure"),
    })
    await expect(run).rejects.toMatchObject({
      stderr: expect.stringContaining(step),
    })
    expect(existsSync(path.join(dir, "shellcheck.jsonl"))).toBe(false)
  })

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
    const calls = await recorded()
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toContain("./scripts/run")
  })

  it("discovers and checks its own classifier once the gates are tracked", async () => {
    // The classifier is the gate's most intricate code; kept inside a single-quoted sh -c
    // string, no linter ever saw it. As a shebanged tracked file it must land in the very
    // set it computes — the gate checks itself.
    const env = await fixture()
    await recordShellcheck()
    const pushed = await commitFixture()

    await runPrePush(env, pushed)
    const calls = await recorded()
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      expect(args).toContain("./.githooks/discover-shell-scripts.sh")
      expect(args).toContain("./.githooks/pre-push")
    }
  })

  it("skips symlink and submodule entries, and says so", async () => {
    // A submodule entry and a symlink, both committed: neither carries script bytes of its own
    // (a link's target is a tracked path, checked under its own name), so neither blocks — but
    // both are disclosed, never silent.
    await write("scripts/keep", "#!/bin/sh\necho ok\n")
    const env = await fixture()
    await recordShellcheck()
    await fs.symlink("nowhere-at-all", path.join(dir, "dangling"))
    await pExecFile("git", ["add", "."], { cwd: dir })
    await pExecFile(
      "git",
      ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendored`],
      { cwd: dir },
    )
    const pushed = await commitFixture({ stage: false })

    const { stdout } = await runPrePush(env, pushed)
    expect(stdout).toContain("2 tracked path(s) that are symlinks or submodule entries")
    for (const args of await recorded()) {
      expect(args).toContain("./scripts/keep")
      expect(args).not.toContain("./dangling")
      expect(args).not.toContain("./vendored")
    }
  })

  it("refuses loudly when a pre-push older than the classifier calls it in the old form", async () => {
    // A hand-edited pre-push is kept across a regeneration while its classifier is replaced.
    // The old call shape must stop the push with a way out — never classify nothing and pass.
    const env = await fixture()
    const discoverOld = path.join(dir, ".githooks", "discover-shell-scripts.sh")
    await expect(
      pExecFile(discoverOld, [path.join(dir, "scratch"), "scripts/run"], { cwd: dir, env }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("run 'etymd gates'") })
  })

  it("treats only the first line as a shebang, so docs embedding one are not scripts", async () => {
    // The shebang read is byte-bounded; a naive bound would let `#!/bin/sh` on a LATER line
    // of a document match the pattern and feed the whole document to the checker.
    await write("docs/example.md", "# Notes\n\n```sh\n#!/bin/sh\necho hi\n```\n")
    const env = await fixture()
    await recordShellcheck()
    const pushed = await commitFixture()

    await runPrePush(env, pushed)
    for (const args of await recorded()) {
      expect(args).not.toContain("./docs/example.md")
    }
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

    it("PINNED: each pushed commit is checked for the scripts it changes, not its whole tree", async () => {
      // The cost being fixed: every script in every pushed commit, so the step grew with the range
      // length times the script count. An untouched script carries its parent's bytes,
      // and the parent was gated when it landed.
      await baseRepo()
      await write("tool/old.sh", "#!/bin/sh\necho old\n")
      await commitAll("chore: an existing script")
      await write("tool/new.sh", "#!/bin/sh\necho new\n")
      await commitAll("chore: one new script")
      await gates()
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("1 commit(s) in the pushed range")
      const calls = await recorded()
      expect(calls.length).toBeGreaterThan(0)
      for (const args of calls) {
        expect(args).toContain("./tool/new.sh")
        expect(args).not.toContain("./tool/old.sh")
      }
    })

    it("a commit that changes no shell script says so, never a silent pass", async () => {
      await baseRepo()
      await write("tool/old.sh", "#!/bin/sh\necho old\n")
      await commitAll("chore: an existing script")
      await write("docs/notes.md", "# Notes\n")
      await commitAll("docs: notes only")
      await gates()
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })
      const head = await revParse("HEAD")

      const { stdout } = await runPrePush(env, update("main", head, await revParse("HEAD~1")))
      expect(stdout).toContain(`no shell script changed in ${head.slice(0, 7)}`)
      expect(existsSync(path.join(dir, "shellcheck.jsonl"))).toBe(false)
    })

    it("a commit changing a .shellcheckrc is checked whole — the verdict moved for every script", async () => {
      await baseRepo()
      await write("tool/old.sh", "#!/bin/sh\necho old\n")
      await commitAll("chore: an existing script")
      await write(".shellcheckrc", "disable=SC2034\n")
      await commitAll("chore: checker config")
      await gates()
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("whole tree")
      for (const args of await recorded()) expect(args).toContain("./tool/old.sh")
    })

    it("a commit deleting a .shellcheckrc is checked whole — the checks it disabled are back", async () => {
      await baseRepo()
      await write(".shellcheckrc", "disable=SC2034\n")
      await write("tool/old.sh", "#!/bin/sh\necho old\n")
      await commitAll("chore: script and checker config")
      await fs.unlink(path.join(dir, ".shellcheckrc"))
      await pExecFile("git", ["rm", "-q", "--cached", ".shellcheckrc"], { cwd: dir })
      await commitAll("chore: drop the checker config")
      await gates()
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("whole tree")
      for (const args of await recorded()) expect(args).toContain("./tool/old.sh")
    })

    it("PINNED: a merge is diffed against its first parent, so the merged side's scripts are read", async () => {
      await baseRepo()
      await pExecFile("git", ["checkout", "-q", "-b", "side"], { cwd: dir })
      await write("tool/side.sh", "#!/bin/sh\necho side\n")
      await commitAll("chore: a script on the side branch")
      await pExecFile("git", ["checkout", "-q", "-"], { cwd: dir })
      await write("docs/notes.md", "# Notes\n")
      await commitAll("docs: main moves on")
      const mainTip = await revParse("HEAD")
      await pExecFile("git", ["merge", "-q", "--no-ff", "-m", "merge side", "side"], {
        cwd: dir,
        env: GIT_ENV,
      })
      await gates()
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })

      await runPrePush(env, update("main", await revParse("HEAD"), mainTip))
      // Two passes (blocking, then advice) for the side commit, and two more for the merge.
      // Diffed against the wrong parent, the merge would show only main's docs change.
      const withSide = (await recorded()).filter((args) => args.includes("./tool/side.sh"))
      expect(withSide).toHaveLength(4)
    })

    it("the commit that installs the gate is checked whole — scripts no gate ever read", async () => {
      await baseRepo()
      await write("tool/legacy.sh", "#!/bin/sh\necho legacy\n")
      await commitAll("chore: a script from before the gate")
      await gates()
      await commitAll("chore: install the gates")
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("whole tree")
      for (const args of await recorded()) expect(args).toContain("./tool/legacy.sh")
    })

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

    it.skipIf(!hasShellcheck)(
      "PINNED: a script marked export-ignore is still checked — the read is not an archive",
      async () => {
        // `git archive` drops export-ignore paths, so an archive-based read let a script leave
        // the checked set without a word. The pushed commit is checked out whole instead.
        await baseRepo()
        await write(".gitattributes", "tool/do.sh export-ignore\n")
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: hidden bad script")
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
      "PINNED: a script checked out with CRLF line endings is still checked — the read is the raw blob",
      async () => {
        // A checkout applies eol and filter attributes: under `eol=crlf` the shebang line ends
        // in a carriage return, the shebang match fails, and the script left the checked set
        // without a word. The gate reads the committed bytes, never a converted checkout.
        await baseRepo()
        await write(".gitattributes", "*.sh text eol=crlf\n")
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: bad script under a crlf attribute")
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
      "PINNED: a .shellcheckrc in the pushed commit still governs the check",
      async () => {
        // Only scripts are read into the scratch tree; the checker finds its config by walking
        // up from each script, so a repo's .shellcheckrc must be read in beside them.
        await baseRepo()
        await write(".shellcheckrc", "disable=SC2034\n")
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: script with a disabled check")
        await gates()
        const env = await stubEnv()

        await runPrePush(env, update("main", await revParse("HEAD"), await revParse("HEAD~1")))
      },
    )

    it.skipIf(!hasShellcheck)(
      "PINNED: with external-sources on, a sourced file without a shebang is there to follow",
      async () => {
        // A sourced helper has no shebang, so it is no script — but under external-sources the
        // checker follows it, and a missing file turns its assignments into false findings.
        await baseRepo()
        await write(".shellcheckrc", "external-sources=true\n")
        await write("tool/lib.inc", "# shellcheck source=tool/inner.inc\n. ./tool/inner.inc\n")
        await write("tool/inner.inc", "greeting=hi\n")
        await write(
          "tool/do.sh",
          '#!/bin/sh\n# shellcheck source=tool/lib.inc\n. ./tool/lib.inc\necho "$greeting"\n',
        )
        await commitAll("chore: script sourcing a helper")
        await gates()
        const env = await stubEnv()

        const { stdout } = await runPrePush(
          env,
          update("main", await revParse("HEAD"), await revParse("HEAD~1")),
        )
        expect(stdout).not.toContain("SC1091")
      },
    )

    it.skipIf(!hasShellcheck)(
      "PINNED: with external-sources on, a quoted helper path with a space is staged whole",
      async () => {
        // Split at the space, the name read would be "my" and the helper never staged.
        await baseRepo()
        await write(".shellcheckrc", "external-sources=true\n")
        await write("tool/my helper.inc", "greeting=hi\n")
        await write("tool/do.sh", '#!/bin/sh\n. "./tool/my helper.inc"\necho "$greeting"\n')
        await commitAll("chore: script sourcing a helper with a space in its name")
        await gates()
        const env = await stubEnv()

        const { stdout } = await runPrePush(
          env,
          update("main", await revParse("HEAD"), await revParse("HEAD~1")),
        )
        expect(stdout).not.toContain("SC1091")
      },
    )

    it.skipIf(!hasShellcheck)(
      "PINNED: with external-sources on, an unrelated file's failing checkout filter does not block",
      async () => {
        // Context is staged as raw blobs of what the scripts source — never a checkout, which
        // would run every tracked file's filters and let an unrelated one refuse the push.
        await baseRepo()
        await pExecFile("git", ["config", "filter.boom.clean", "cat"], { cwd: dir })
        await pExecFile("git", ["config", "filter.boom.smudge", "false"], { cwd: dir })
        await pExecFile("git", ["config", "filter.boom.required", "true"], { cwd: dir })
        await write(".gitattributes", "*.bin filter=boom\n")
        await write("data.bin", "payload\n")
        await write(".shellcheckrc", "external-sources=true\n")
        await write("tool/do.sh", "#!/bin/sh\necho ok\n")
        await commitAll("chore: a filtered file beside a script")
        await gates()
        const env = await stubEnv()

        await runPrePush(env, update("main", await revParse("HEAD"), await revParse("HEAD~1")))
      },
    )

    it.skipIf(!hasShellcheck)(
      "a remote sha this clone has never seen falls back to the new-branch range, not a refusal",
      async () => {
        // The remote moved on since the last fetch: its sha cannot bound a range here. Refusing
        // would block a push the gate can read, so the push is checked as a new branch — and a
        // bad commit in it still refuses.
        await baseRepo()
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: bad script")
        await gates()
        const env = await stubEnv()
        const head = await revParse("HEAD")
        const unseen = "1".repeat(40)

        await expect(runPrePush(env, update("main", head, unseen))).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining("SC2034"),
        })
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
