import { execFile, execSync, spawnSync } from "node:child_process"
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

/** The same run, with the remote git would pass as $1 — a name for a configured remote, a
 * URL for an anonymous push. The range bound is chosen from this argument. */
async function runPrePushRemote(env: NodeJS.ProcessEnv, remote: string, ...refLines: string[]) {
  const refsFile = path.join(dir, ".pushed-refs")
  await fs.writeFile(refsFile, refLines.join("\n") + (refLines.length ? "\n" : ""), "utf8")
  return pExecFile("sh", ["-c", '".githooks/pre-push" "$1" < "$2"', "sh", remote, refsFile], {
    cwd: dir,
    env,
  })
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
 * path travels by environment, never by relative filename. `--version` answers like the real
 * checker (optionally a chosen one) and is never recorded: the hook probes it once per push
 * for the re-baseline stamp, not as a check. */
async function recordShellcheck(version = "") {
  await stub(
    "shellcheck",
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("version: ${version}\\n")
  process.exit(0)
}
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

  it("passes whitespace, quotes and leading hyphens unchanged to the checker", async () => {
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
    // The earlier shape inverted this: the working tree was never the right read. Deleting the
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

  it("the classifier header states the interface the hook actually invokes", async () => {
    // The header is the spec the next pack maintainer reads: the 2026-09-28 review caught it
    // numbering a mode as "the second" twice. This pins header and invocation to the same
    // claim — every mode the hook dispatches appears in the header's call list, and every
    // mode the header names is one the hook actually invokes — so neither can drift.
    await baseRepo()
    await write("tool/run.sh", "#!/bin/sh\necho ok\n")
    await pExecFile("git", ["add", "."], { cwd: dir })
    await gates()
    const hook = await prePush()
    const classifier = await fs.readFile(
      path.join(dir, ".githooks", "discover-shell-scripts.sh"),
      "utf8",
    )
    expect(classifier).toContain("Four calls per commit")
    for (const mode of ["--config", "--skips", "--commit", "--context"]) {
      expect(hook).toContain(`"$discover" ${mode}`)
      expect(classifier).toContain(mode)
    }
  })

  // Merge 2026-10-02: the branch's "repointing a symlink classifies the bytes the link now
  // ships" pin was dropped — the merged gate keeps the shipped design where a symlink is a
  // disclosed skip and its target is checked under its own path ("skips symlink and submodule
  // entries, and says so" below). The narrower coverage gap (a repointed link whose target
  // otherwise changes nothing) is named in the merge commit for a deliberate follow-up.
  // Merge 2026-10-02: the branch's "sourced helpers resolve through the checker, not a
  // hook-side parser" pin was dropped — the merged gate keeps the shipped staging pipeline
  // (source lines read from staged files, helpers staged as raw blobs until nothing new is
  // sourced), pinned by the external-sources series in "the range being pushed" below. The
  // checker-resolves alternative stays recorded in the merge commit as a direction to weigh.

  // The one-run verdict tests below were rewritten for this branch's per-commit ranges —
  // the originals drove the gate over the working tree. The quiet-set case was not ported:
  // "a delete-only push has nothing to check and says so" below pins the same behaviour
  // where the range design actually decides it.
  it.skipIf(!hasShellcheck)(
    "one run is both verdict and advice: a warning blocks, a style note does not",
    async () => {
      await write("scripts/warn", "#!/bin/sh\nnever_used=1\necho ok\n")
      await write("scripts/style", '#!/bin/sh\nx=`date`\necho "$x"\n')
      const env = await fixture()
      const pushed = await commitFixture()

      const failure = await runPrePush(env, pushed).then(
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
    "a SHELLCHECK_OPTS format override cannot soften the verdict",
    async () => {
      // The environment's -f replaces the gate's own format flag, and the one-run parser reads
      // gcc lines: under '-f json' a warning-level finding reached the advice block and the
      // push passed. The override is stripped from the gate's run, and the strip is said.
      await write("scripts/warn", "#!/bin/sh\nnever_used=1\necho ok\n")
      const env = await fixture()
      const pushed = await commitFixture()

      const failure = await runPrePush({ ...env, SHELLCHECK_OPTS: "-f json" }, pushed).then(
        () => {
          throw new Error("expected the warning to block the push under a format override")
        },
        (error) => error,
      )
      expect(failure.code).toBe(1)
      expect(failure.stdout).toContain("SC2034")
      expect(failure.stdout).toContain("SHELLCHECK_OPTS")
    },
  )

  it.skipIf(!hasShellcheck)(
    "a style-only script passes the push and keeps its advice",
    async () => {
      await write("scripts/style", '#!/bin/sh\nx=`date`\necho "$x"\n')
      const env = await fixture()
      const pushed = await commitFixture()

      const { stdout } = await runPrePush(env, pushed)
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
    const pushed = await commitFixture()

    await runPrePush(env, pushed)
    const calls = await recorded()
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toContain("./scripts/eol-less")
  })
})

describe.skipIf(!existsSync(CLI))(
  "etymd gates — the range being pushed, not the tree or the tip",
  () => {
    // Merge 2026-10-02: the branch's "a refusal over an unresolved source names the source"
    // pin was dropped with the checker-resolves design it tested; the merged gate stages what
    // resolves and refuses on the finding that remains, per the external-sources series below.
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

    it("PINNED: a branch that merged commits a remote already has does not re-check them", async () => {
      // The defect this pins: the existing-branch range was "$rsha..$lsha" with no remote
      // subtraction, so a branch that merged the upstream re-checked every upstream commit
      // since its base — each at its own tree, where later fixes do not exist, so a push of
      // a clean branch was refused on warnings a later commit had already fixed. A remote
      // already gated those commits when they landed there; the same subtraction the
      // new-branch case uses bounds this range too.
      await baseRepo()
      await write("tool/main-side.sh", "#!/bin/sh\necho main\n")
      await commitAll("chore: main-side script")
      const mainSide = await revParse("HEAD")
      // The remote-tracking ref says a remote already has this commit.
      await pExecFile("git", ["update-ref", "refs/remotes/origin/main", mainSide], { cwd: dir })
      await pExecFile("git", ["checkout", "-q", "-b", "topic", "HEAD~1"], {
        cwd: dir,
        env: GIT_ENV,
      })
      await write("tool/topic-side.sh", "#!/bin/sh\necho topic\n")
      await commitAll("chore: topic-side script")
      const topicTip = await revParse("HEAD")
      await pExecFile("git", ["merge", "-q", "--no-ff", mainSide, "-m", "merge the main side"], {
        cwd: dir,
        env: GIT_ENV,
      })
      const merged = await revParse("HEAD")
      await gates()
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })

      const { stdout } = await runPrePush(env, update("topic", merged, topicTip))
      // The old range said "2 commit(s)" — the merge AND the already-remote main commit,
      // each re-checked at its own tree. One commit is left: the merge itself.
      expect(stdout).toContain("1 commit(s) in the pushed range")
      const calls = await recorded()
      expect(calls.length).toBeGreaterThan(0)
      for (const args of calls) {
        // The merge's own first-parent diff still reads the merged side's script; the
        // already-remote commit's separate re-read is gone, and the remote tip's script
        // (checked when it landed there) never reaches the checker.
        expect(args).toContain("./tool/main-side.sh")
        expect(args).not.toContain("./tool/topic-side.sh")
      }
    })

    it.skipIf(!hasShellcheck)(
      "PINNED: a commit another remote already has is gated when pushed elsewhere — fetched is not gated",
      async () => {
        // The failure being fixed: the new-branch rule negated EVERY remote's tracking refs,
        // so a commit merely fetched from a second remote (git fetch coworker, then push here)
        // counted as already gated although no gate ever read it — it shipped unchecked. The
        // bound is the remote being pushed TO, so the fetched commit stays in the range.
        await baseRepo()
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: bad script")
        const bad = await revParse("HEAD")
        await write("docs/notes.md", "# Notes\n")
        await commitAll("docs: clean tip")
        await gates()
        const env = await stubEnv()
        // origin is configured but holds nothing; a second remote's tracking ref already
        // carries the bad commit, exactly as a fetch would have left it.
        await pExecFile("git", ["remote", "add", "origin", path.join(dir, "origin.git")], {
          cwd: dir,
        })
        await pExecFile("git", ["update-ref", "refs/remotes/other/main", bad], { cwd: dir })
        const head = await revParse("HEAD")

        // origin negates nothing of this history, so the whole of it is the push: 3 commits,
        // bad one included, and its script refuses the push.
        await expect(
          runPrePushRemote(env, "origin", update("main", head, ZERO)),
        ).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining("3 commit(s) in the pushed range"),
        })
      },
    )

    it.skipIf(!hasShellcheck)(
      "a URL-targeted push keeps the wide bound — no configured remote to narrow by",
      async () => {
        // $1 as a URL matches no configured remote, and --remotes=<url> would negate nothing —
        // a fresh clone's entire history checked on its first push. The hook falls back to
        // every remote-tracking ref, so the fetched commit stays excluded exactly as before
        // the bound was narrowed.
        await baseRepo()
        await write("tool/do.sh", "#!/bin/sh\nnever_used=1\necho ok\n")
        await commitAll("chore: bad script")
        const bad = await revParse("HEAD")
        await write("docs/notes.md", "# Notes\n")
        await commitAll("docs: clean tip")
        await gates()
        const env = await stubEnv()
        await pExecFile("git", ["remote", "add", "origin", path.join(dir, "origin.git")], {
          cwd: dir,
        })
        await pExecFile("git", ["update-ref", "refs/remotes/other/main", bad], { cwd: dir })
        const head = await revParse("HEAD")

        const { stdout } = await runPrePushRemote(
          env,
          path.join(dir, "origin.git"),
          update("main", head, ZERO),
        )
        expect(stdout).toContain("1 commit(s) in the pushed range")
        expect(stdout).not.toContain("SC2034")
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

    it("PINNED: a newline inside a touched path neither forces nor dodges the whole-tree read", async () => {
      // The trigger read the NUL-delimited touched list as lines: a path holding a newline split
      // into two records, and "tool/pre-push<newline>notes.txt" passed for the gate, so every
      // commit touching it was checked whole. Asked of git by pathspec, no record is parsed.
      await baseRepo()
      await write("tool/old.sh", "#!/bin/sh\necho old\n")
      await commitAll("chore: an existing script")
      await gates()
      await write("tool/pre-push\nnotes.txt", "not a hook\n")
      await write("tool/new.sh", "#!/bin/sh\necho new\n")
      // Only tool/: `git add .` would commit the generated .githooks too, and a commit that
      // touches the gate is checked whole by rule — the very read this test says must not happen.
      await pExecFile("git", ["add", "--", "tool"], { cwd: dir })
      await pExecFile(
        "git",
        ["commit", "-q", "-m", "chore: a newline path beside one new script"],
        {
          cwd: dir,
          env: GIT_ENV,
        },
      )
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("1 commit(s) in the pushed range")
      expect(stdout).not.toContain("whole tree")
      const calls = await recorded()
      expect(calls.length).toBeGreaterThan(0)
      for (const args of calls) {
        expect(args).toContain("./tool/new.sh")
        expect(args).not.toContain("./tool/old.sh")
      }
    })

    it("PINNED: a .shellcheckrc deleted two directories down checks the commit whole", async () => {
      // Deletion included: a removed config re-enables every check it disabled, two levels
      // down as at the root. And an exported GIT_LITERAL_PATHSPECS would read the trigger's
      // glob as a plain path and find nothing — the narrow path, in silence — so the hook
      // clears it for that call; this run exports it to prove the clearing.
      await baseRepo()
      await write("tool/old.sh", "#!/bin/sh\necho old\n")
      await write("tool/deep/.shellcheckrc", "disable=SC2034\n")
      await commitAll("chore: a script and a nested config")
      await gates()
      await pExecFile("git", ["rm", "-q", "tool/deep/.shellcheckrc"], { cwd: dir })
      await pExecFile("git", ["commit", "-q", "-m", "chore: drop the nested config"], {
        cwd: dir,
        env: GIT_ENV,
      })
      await recordShellcheck()
      const env = await stubEnv({
        ETYMD_RECORD: path.join(dir, "shellcheck.jsonl"),
        GIT_LITERAL_PATHSPECS: "1",
      })

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("whole tree")
      const calls = await recorded()
      expect(calls.length).toBeGreaterThan(0)
      for (const args of calls) expect(args).toContain("./tool/old.sh")
    })

    // Merge 2026-10-02: the branch's "the narrow path probes the tree root" pin was dropped —
    // it guarded the empty-extraction probe of the deleted materialise-and-read design. The
    // invariant it served (the narrow path checks the changed scripts, never the whole tree as
    // the checked set) stays pinned by "each pushed commit is checked for the scripts it
    // changes" above; the whole-tree listing the merged hook does run feeds .shellcheckrc and
    // source staging, never the checked set.
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

    it("POSIX-padded wc counts still gate — the tallies are read whitespace-safe", async () => {
      // POSIX permits wc to pad its counts with leading blanks, and an integer test on a padded
      // read is implementation-defined. The shim pads every count the hook takes — bytes and
      // lines alike — so both reads prove their tolerance: the tallies fold through arithmetic,
      // the upfront commit count already strips. A rejecting [ would turn the gate branches
      // false and silently skip the checker; here it must still run and report one script.
      await baseRepo()
      await write("tool/one.sh", "#!/bin/sh\necho one\n")
      await commitAll("chore: one script")
      await gates()
      await recordShellcheck()
      await stub(
        "wc",
        `#!/usr/bin/env node
// A POSIX-legal hostile wc: every count padded with leading blanks.
const s = require("node:fs").readFileSync(0, "utf8")
const n = process.argv.includes("-c") ? Buffer.byteLength(s) : (s.match(/\\n/g) || []).length
process.stdout.write("      " + n + "\\n")
`,
      )
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("1 commit(s) in the pushed range")
      expect(stdout).toContain("shellcheck (1 scripts")
      expect((await recorded()).length).toBeGreaterThan(0)
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

    it.skipIf(!hasShellcheck)(
      "a .shellcheckrc-only change is honoured without touching scripts",
      async () => {
        // The commit's whole tree is materialised (checkout-index writes every tracked blob,
        // config included), so the whole-tree check after a config-only change runs under the
        // repo's own checker config: the disabled finding stays disabled. Without the config
        // being read, shellcheck blocks this push on SC2034 — that it passes is the pin.
        await baseRepo()
        await write("tool/legacy.sh", "#!/bin/sh\nunused=1\n")
        await commitAll("chore: a script the checker would flag")
        await write(".shellcheckrc", "disable=SC2034\n")
        await commitAll("chore: silence it in the checker config")
        await gates()
        const env = await stubEnv()

        const { stdout } = await runPrePush(
          env,
          update("main", await revParse("HEAD"), await revParse("HEAD~1")),
        )
        expect(stdout).toContain("whole tree")
        expect(stdout).toContain("1 scripts")
      },
    )

    it("a shellcheck upgrade re-checks the whole shell surface once", async () => {
      // A checker release can flag bytes nobody touched; the per-commit read would leave the
      // finding waiting for each script's next edit. The hook stamps the checker's version
      // in the git dir and re-checks whole on the first push after it moves — and only that
      // push: the new stamp is written after the checks pass, so a refused or interrupted
      // push re-runs the re-baseline instead of trusting one that never completed.
      await baseRepo()
      await write("tool/old.sh", "#!/bin/sh\necho old\n")
      await commitAll("chore: an existing script")
      await write("tool/new.sh", "#!/bin/sh\necho new\n")
      await commitAll("chore: one new script")
      await gates()
      await recordShellcheck("1.0.0")
      let env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })
      await runPrePush(env, update("main", await revParse("HEAD"), await revParse("HEAD~1")))
      for (const args of await recorded()) {
        expect(args).toContain("./tool/new.sh")
        expect(args).not.toContain("./tool/old.sh")
      }

      await write("docs/notes.md", "# Notes\n")
      await commitAll("docs: no script touched")
      await recordShellcheck("2.0.0")
      env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })
      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("the checker changed (1.0.0 → 2.0.0)")
      expect(stdout).toContain("whole tree")
      expect((await recorded()).some((args) => args.includes("./tool/old.sh"))).toBe(true)
    })

    it("PINNED: a refused push does not consume the checker-change re-baseline", async () => {
      // The stamp used to be written before the checks ran, so a push the checker's new
      // version refused still recorded the new version — the retry then read only touched
      // paths and the whole-surface re-baseline never completed. The stamp moves only after
      // the checks pass; a failed push leaves the prior stamp, and the retry re-runs it.
      const cleanAt = (version: string) =>
        stub(
          "shellcheck",
          `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("version: ${version}\\n")
  process.exit(0)
}
`,
        )
      const flaggingAt = (version: string) =>
        stub(
          "shellcheck",
          `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("version: ${version}\\n")
  process.exit(0)
}
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("./")) process.stdout.write(arg + ":1:1: warning: a fabricated finding [SC2034]\\n")
}
process.exit(1)
`,
        )
      await baseRepo()
      await write("tool/do.sh", "#!/bin/sh\necho ok\n")
      await commitAll("chore: a script")
      await gates()
      await cleanAt("1.0.0")
      await runPrePush(
        await stubEnv(),
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )

      await write("docs/notes.md", "# Notes\n")
      await commitAll("docs: no script touched")
      await flaggingAt("2.0.0")
      const env = await stubEnv()
      await expect(
        runPrePush(env, update("main", await revParse("HEAD"), await revParse("HEAD~1"))),
      ).rejects.toMatchObject({ code: 1 })

      // Same push, retried: the refused attempt left 1.0.0 in the stamp, so the checker
      // change is still news — the whole-surface re-baseline runs again, not the narrow read.
      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      ).then(
        () => {
          throw new Error("the flagging checker must keep refusing this push")
        },
        (error) => error,
      )
      expect(stdout).toContain("the checker changed (1.0.0 → 2.0.0)")
      expect(stdout).toContain("whole tree")
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
      // One checker run per pushed commit: the side commit's and the merge's. Diffed against
      // the wrong parent, the merge would show only main's docs change.
      const withSide = (await recorded()).filter((args) => args.includes("./tool/side.sh"))
      expect(withSide).toHaveLength(2)
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

// `script` gives the hook a pty on stdin — the exact condition a hand run from a terminal
// creates. BSD script (macOS) takes the command as trailing arguments; util-linux (Linux)
// wants -c. Elsewhere there is no portable pty, so the behaviour is untested there.
const bsdScript = process.platform === "darwin"
describe.skipIf(!existsSync(CLI) || !(bsdScript || process.platform === "linux"))(
  "etymd gates — a hand run of the push gate",
  () => {
    it("PINNED: a terminal stdin reads no refs and says so — it never waits on the keyboard", async () => {
      // The failure being fixed: `refs=$(cat)` on a terminal stdin blocks forever with no
      // prompt — a long silent hook reads as a hung one. The capture reads only when stdin
      // is NOT a terminal; a manual run is told why it sees no refs, and the gate completes.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      // A checker on PATH (the recording stub) so the shell step exists and its nothing-to-
      // check line can prove the empty-refs path completed; the real checker is never run.
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })
      const hook = path.join(dir, ".githooks", "pre-push")
      const args = bsdScript
        ? ["-q", "/dev/null", "sh", hook, "origin", "url"]
        : ["-q", "-c", `sh '${hook}' origin url`, "/dev/null"]
      // Before the guard, the run blocks on the pty and is killed here by the timeout.
      // script's own stdin is /dev/null: it allocates the child's pty itself, and probing a
      // socket stdin (the harness) makes BSD script abort before the hook ever runs.
      const res = spawnSync("script", args, {
        cwd: dir,
        env,
        timeout: 10000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      expect(res.error).toBeUndefined()
      expect(res.status).toBe(0)
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.replaceAll("\r\n", "\n")
      expect(out).toContain("no pushed refs")
      expect(out).toContain("nothing to check")
    })
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

  it("a tab or carriage return after the interpreter still lands the script in the sh bucket", async () => {
    // `( |$)` matched a literal space or end-of-line only, so `#!/bin/sh<TAB>-e` and any
    // CRLF-committed first line matched NO bucket: not checked, not excluded, not disclosed —
    // the silent coverage shrink the fail-closed rules promise cannot happen.
    await pExecFile("git", ["config", "core.autocrlf", "false"], { cwd: dir })
    await baseRepo()
    await write("tool/tab.sh", "#!/bin/sh\t-e\nexit 0\n")
    await write("tool/crlf.sh", "#!/bin/sh\r\nexit 0\r\n")
    await write("tool/run.zsh", "#!/bin/zsh\necho hi\n")
    await commitAll("chore: shebang edge cases")
    await gates()
    await recordShellcheck()
    const log = path.join(dir, "shellcheck.jsonl")
    const env = await stubEnv({ ETYMD_RECORD: log })
    const base = await revParse("HEAD~1")
    const head = await revParse("HEAD")

    const { stdout } = await runPrePush(env, update("main", head, base))
    const calls = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(1)
    for (const args of calls) {
      expect(args.filter((arg) => arg.startsWith("./")).sort()).toEqual([
        "./tool/crlf.sh",
        "./tool/tab.sh",
      ])
    }
    expect(stdout).toContain("2 scripts")
    // The zsh twin keeps its disclosed exclusion — widening sh must not swallow it.
    expect(stdout).toContain("1 zsh script(s) excluded")
  })

  it("PINNED: a ksh script is counted and announced, never silently unread", async () => {
    // The classifier had two arms — sh-family and zsh; every other shebang (ksh, ash) matched
    // neither: no bucket, no check, no disclosure. The third bucket counts it and the hook
    // says so at run time, the same honesty as the zsh exclusion.
    await baseRepo()
    await write("tool/run.ksh", "#!/bin/ksh\necho hi\n")
    await write("tool/do.sh", "#!/bin/sh\necho ok\n")
    await commitAll("chore: ksh and sh tools")
    await gates()
    await recordShellcheck()
    const log = path.join(dir, "shellcheck.jsonl")
    const env = await stubEnv({ ETYMD_RECORD: log })
    const base = await revParse("HEAD~1")
    const head = await revParse("HEAD")

    const { stdout } = await runPrePush(env, update("main", head, base))
    const calls = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    // The one run sees only the sh script — the ksh one is never handed to the checker.
    expect(calls).toHaveLength(1)
    for (const args of calls) {
      expect(args.filter((arg) => arg.startsWith("./"))).toEqual(["./tool/do.sh"])
    }
    // …and the exclusion is disclosed at run time, not silent.
    expect(stdout).toContain("1 script(s) under another interpreter")
    expect(stdout).toContain("not checked, not failed")
  })

  it.skipIf(!hasShellcheck)(
    "PINNED: a shebang with a tab before its flag pushes clean through real shellcheck",
    async () => {
      await baseRepo()
      await write("tool/tab.sh", "#!/bin/sh\t-e\nexit 0\n")
      await commitAll("chore: tab shebang")
      await gates()
      const env = await stubEnv()
      const base = await revParse("HEAD~1")
      const head = await revParse("HEAD")
      // Before the fix this push said nothing at all about the script — no bucket, no check.
      const { stdout } = await runPrePush(env, update("main", head, base))
      expect(stdout).toContain("shellcheck (1 scripts")
    },
  )

  it.skipIf(!hasShellcheck)(
    "PINNED: a CRLF-committed sh script is checked and blocks naming SC1017",
    async () => {
      await pExecFile("git", ["config", "core.autocrlf", "false"], { cwd: dir })
      await baseRepo()
      await write("tool/crlf.sh", "#!/bin/sh\r\nexit 0\r\n")
      await commitAll("chore: crlf script")
      await gates()
      const env = await stubEnv()
      const base = await revParse("HEAD~1")
      const head = await revParse("HEAD")
      let blocked: { stdout?: string; stderr?: string } | undefined
      await runPrePush(env, update("main", head, base)).catch((e) => {
        blocked = e
      })
      // SC1017 is shellcheck's own carriage-return verdict: the script was read, named and
      // blocked. The old class checked nothing and the push sailed through — the hole this
      // pins shut.
      expect(blocked?.stdout ?? "").toContain("SC1017")
    },
  )

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

      // Every hook that resolves a screener, not just the one the failure was noticed at.
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
  "etymd gates — a screening hook that explains its own failure",
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
    it.skipIf(!hasShellcheck)(
      "PINNED: every generated hook is shellcheck-clean at warning",
      async () => {
        // A hook that gates on shellcheck must survive shellcheck itself. The specific trap this
        // pins: any comment whose first word is the checker's own name is parsed as a DIRECTIVE, so
        // prose explaining why a shell dialect is skipped can itself become a parse error — a
        // generated gate breaking the tool it exists to run.
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
      },
    )
  },
)

describe.skipIf(!existsSync(CLI))("etymd gates — a set-but-unusable override refuses", () => {
  /** Deterministic doors: no ambient etymd, no shell surface — only the override under test. */
  async function bareFixture() {
    await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await pExecFile("git", ["add", "."], { cwd: dir })
    await gates()
  }

  /** A hook run's exit status and stderr, passed or refused. stdin must reach EOF: pre-push
   * reads the pushed refs from it, and execFile leaves its pipe open — without /dev/null the
   * read blocks forever (git itself always closes stdin). */
  async function door(hook: string, args: string[], env: NodeJS.ProcessEnv) {
    return pExecFile("sh", ["-c", '"$0" "$@" < /dev/null', hook, ...args], { cwd: dir, env }).then(
      ({ stderr }) => ({ code: 0, stderr }),
      (e: { code?: number; stderr?: string }) => ({ code: e.code ?? -1, stderr: e.stderr ?? "" }),
    )
  }

  it("PINNED: pre-push with CONTENT_GATE naming a missing path refuses, and says the ways out", async () => {
    // Until pack 27 the door said so on stderr and opened. A hook that passes shows its stderr
    // to nobody in a GUI client, so the typo stayed and the screen it was set to tighten stayed
    // off. The variable was set on purpose; a broken value refuses like any broken gate.
    await bareFixture()

    const env = { ...process.env, CONTENT_GATE: path.join(dir, "no-such-checker") }
    const run = await door(".githooks/pre-push", [], env)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain("pre-push: CONTENT_GATE is set but not usable")
    expect(run.stderr).toContain("no-such-checker")
    expect(run.stderr).toContain("or unset it")
  })

  it("pre-commit and commit-msg refuse their broken overrides too", async () => {
    await bareFixture()

    const staged = { ...process.env, CONTENT_GATE: path.join(dir, "no-such-checker") }
    const pc = await door(".githooks/pre-commit", [], staged)
    expect(pc.code).toBe(1)
    expect(pc.stderr).toContain("pre-commit: CONTENT_GATE is set but not usable")

    const msg = path.join(dir, "msg.txt")
    await fs.writeFile(msg, "chore: gate\n", "utf8")
    const msgEnv = { ...process.env, COMMIT_MSG_GATE: path.join(dir, "no-such-checker") }
    const cm = await door(".githooks/commit-msg", [msg], msgEnv)
    expect(cm.code).toBe(1)
    expect(cm.stderr).toContain("commit-msg: COMMIT_MSG_GATE is set but not usable")
  })

  it("an unset gate stays a silent no-op — the line is for misconfiguration, not absence", async () => {
    await bareFixture()

    const { stderr } = await pExecFile("sh", ["-c", '".githooks/pre-push" < /dev/null', "sh"], {
      cwd: dir,
    })
    expect(stderr).not.toContain("is set but not usable")
  })
})

describe.skipIf(!existsSync(CLI))("etymd gates — the push-time audit reads the pushed tips", () => {
  /** An audit stand-in that reports where it ran, and fails only inside a tree carrying
   * BLOCK=1 — so the fixture can plant the gap on the branch, the checkout, or neither. */
  async function auditStub() {
    await write(
      ".stub-bin/etymd",
      '#!/bin/sh\nprintf \'%s %s\\n\' "$1" "$(pwd)" >> "$ETYMD_RECORD"\nif [ "$1" = "audit" ] && [ "$(cat "$PWD/BLOCK" 2>/dev/null)" = "1" ]; then\n  echo "gap-level finding at $(pwd)"\n  exit 1\nfi\nexit 0\n',
    )
    await fs.chmod(path.join(dir, ".stub-bin/etymd"), 0o755)
  }

  async function pushEnv(): Promise<NodeJS.ProcessEnv> {
    await auditStub()
    const log = path.join(dir, "audit-paths.log")
    return {
      ...process.env,
      PATH: `${path.join(dir, ".stub-bin")}${path.delimiter}${process.env.PATH}`,
      ETYMD_RECORD: log,
    }
  }

  it("PINNED: a gap in the pushing CHECKOUT cannot block a clean branch — the audit runs at the pushed tip", async () => {
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await commitAll("chore: script")
    await gates()
    const env = await pushEnv()
    const base = await revParse("HEAD~1")
    const head = await revParse("HEAD")
    // The working tree carries the gap; the pushed commits do not.
    await write("BLOCK", "1\n")

    const { stdout } = await runPrePush(env, update("main", head, base))
    expect(stdout).toContain("the pushed tip")
    const lines = (await fs.readFile(path.join(dir, "audit-paths.log"), "utf8")).trim().split("\n")
    const audits = lines.filter((l) => l.startsWith("audit "))
    expect(audits).toHaveLength(1)
    // The audit stood in a materialised worktree of the tip, not in the pushing checkout —
    // where the gap lives and would have refused this clean branch.
    expect(audits[0]?.endsWith(dir)).toBe(false)
    expect(stdout).not.toContain("gap-level finding")
  })

  it("PINNED: the audit's worktree carries raw blobs — a converting checkout filter cannot change what is audited", async () => {
    // git archive (the old materialiser) runs working-tree conversion: a required filter
    // killed it mid-stream and its death inside the pipeline read as tar's status — the audit
    // then ran over an EMPTY tree; a non-required one handed the audit CONVERTED bytes. Both
    // are the same lie: the gate certifying bytes it never read. Every entry is now written
    // as its raw blob, no filter ever runs, and a converting filter changes nothing seen.
    await baseRepo()
    await pExecFile("git", ["config", "filter.smudge.smudge", "sed s/payload/SMUDGED/"], {
      cwd: dir,
    })
    await pExecFile("git", ["config", "filter.smudge.clean", "cat"], { cwd: dir })
    await pExecFile("git", ["config", "filter.smudge.required", "true"], { cwd: dir })
    await write(".gitattributes", "*.bin filter=smudge\n")
    await write("data.bin", "payload\n")
    await commitAll("chore: a filtered file")
    await gates()
    const env = await stubEnv()
    // The audit stand-in fails unless it reads the committed bytes: present and unconverted.
    await write(
      ".stub-bin/etymd",
      '#!/bin/sh\n[ "$(cat data.bin 2>/dev/null)" = "payload" ] || { echo "audit read: $(cat data.bin 2>/dev/null)"; exit 1; }\nexit 0\n',
    )
    await fs.chmod(path.join(dir, ".stub-bin", "etymd"), 0o755)

    const { stdout, stderr } = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    )
    expect(stdout).toContain("the pushed tip")
    expect(stderr).not.toContain("external filter")
  })

  it("PINNED: the audit worktree's index is filled and the checkout's node_modules is linked in", async () => {
    // Two quiet gates in one materialisation: --no-checkout leaves a worktree's index EMPTY,
    // so the audit's git-scoped enumeration (ls-files) listed nothing while every file sat on
    // disk — the comment lens answered "nothing to check" and never gated a push. And a tree
    // without node_modules degrades every command claim into "unverifiable, skipped" — dead
    // commands are the main risk-tier finding. read-tree fills the index from the pushed
    // commit; the checkout's install is linked in, because installed binaries belong to the
    // checkout, not the commit.
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await commitAll("chore: script")
    await gates()
    const env = await pushEnv()
    await fs.mkdir(path.join(dir, "node_modules", ".bin"), { recursive: true })
    // Records what an etymd standing in the audit worktree would see: how many tracked files
    // ls-files lists (0 was the defect), and whether node_modules resolves. The label keeps
    // the audit call apart from the advisory content screen, which routes here too.
    await stub(
      "etymd",
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then printf "version: 0.0.0-stub\\n"; exit 0; fi',
        'printf \'%s %s\\n\' "$1" "$(git ls-files | wc -l | tr -d "[:space:]")" >> "$ETYMD_RECORD"',
        '[ "$1" = "audit" ] && [ -e node_modules/.bin ] && printf "audit-linked\\n" >> "$ETYMD_RECORD"',
        "exit 0",
      ].join("\n") + "\n",
    )

    const { stdout } = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    )
    expect(stdout).toContain("the pushed tip")
    const log = await fs.readFile(path.join(dir, "audit-paths.log"), "utf8")
    const auditCount = log
      .split("\n")
      .find((l) => /^audit \d+$/.test(l.trim()))
      ?.trim()
    expect(auditCount).toBeDefined()
    expect(Number(auditCount?.split(" ")[1])).toBeGreaterThan(0)
    expect(log).toContain("audit-linked")
  })

  it("PINNED: a gap ON THE PUSHED BRANCH refuses the push even from a clean checkout", async () => {
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await write("BLOCK", "1\n")
    await commitAll("chore: script and gap")
    await gates()
    const env = await pushEnv()
    const base = await revParse("HEAD~1")
    const head = await revParse("HEAD")
    // The checkout is clean OF the gap (uncommitted edit only) — the old audit read exactly
    // this tree and passed; the pushed tip still carries it.
    await write("BLOCK", "0\n")

    await expect(runPrePush(env, update("main", head, base))).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("gap-level finding"),
    })
  })

  it("a push that carries no commits audits nothing and says so", async () => {
    await baseRepo()
    await gates()
    const env = await pushEnv()
    const head = await revParse("HEAD")

    const { stdout } = await runPrePush(env, update("main", head, head))
    expect(stdout).toContain("nothing to audit")
    // And the audit never ran (the content screen's call is the only etymd invocation).
    const lines = (await fs.readFile(path.join(dir, "audit-paths.log"), "utf8")).trim().split("\n")
    expect(lines.filter((l) => l.startsWith("audit "))).toEqual([])
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
/**
 * The staged tree against a full checkout, case by case from shellcheck's own documentation
 * (the man page's RC FILES and DIRECTIVES sections): every input the checker reads from the
 * repository must reach it in the hook's scratch tree just as it would in a checkout. Unit
 * cases pin the bugs someone found; this table pins the inputs the checker documents, so a
 * change to how the hook reads a commit cannot drop one without a row going red.
 *
 * The reference is shellcheck itself, run at the blocking bar on a real checkout of the same
 * commit. HOME and XDG_CONFIG_HOME point at an empty directory in both runs, so a personal
 * config can never make two different reads agree. A row marked `gap` is a known difference,
 * recorded in docs/limitations.md: it runs as an expected failure, and turns red the day it is
 * fixed.
 */
describe.skipIf(!existsSync(CLI) || !hasShellcheck)(
  "etymd gates — the staged tree reads like a checkout, for every input shellcheck documents",
  () => {
    type Row = { name: string; files: Record<string, string>; scripts: string[]; gap?: string }
    const unused = "#!/bin/sh\nnever_used=1\necho ok\n"
    const uses = (line: string) => `#!/bin/sh\n${line}\necho "$greeting"\n`
    const rows: Row[] = [
      {
        name: "a root .shellcheckrc governs every script",
        files: { ".shellcheckrc": "disable=SC2034\n", "tool/do.sh": unused },
        scripts: ["tool/do.sh"],
      },
      {
        name: "a root shellcheckrc (no dot) governs every script",
        files: { shellcheckrc: "disable=SC2034\n", "tool/do.sh": unused },
        scripts: ["tool/do.sh"],
        gap: "docs/limitations.md: the pre-push hook stages only .shellcheckrc",
      },
      {
        name: "a nested .shellcheckrc governs only its own subtree",
        files: { "sub/.shellcheckrc": "disable=SC2034\n", "sub/a.sh": unused, "b.sh": unused },
        scripts: ["sub/a.sh", "b.sh"],
      },
      {
        name: "external-sources=true follows a sourced helper with no shebang",
        files: {
          ".shellcheckrc": "external-sources=true\n",
          "tool/lib.inc": "greeting=hi\n",
          "tool/do.sh": uses(". ./tool/lib.inc"),
        },
        scripts: ["tool/do.sh"],
      },
      {
        name: 'a quoted external-sources="true" follows a sourced helper',
        files: {
          ".shellcheckrc": 'external-sources="true"\n',
          "tool/lib.inc": "greeting=hi\n",
          "tool/do.sh": uses(". ./tool/lib.inc"),
        },
        scripts: ["tool/do.sh"],
        gap: "docs/limitations.md: the pre-push hook reads only an unquoted external-sources=true",
      },
      {
        name: "a helper's own helper is followed",
        files: {
          ".shellcheckrc": "external-sources=true\n",
          "tool/lib.inc": "# shellcheck source=tool/inner.inc\n. ./tool/inner.inc\n",
          "tool/inner.inc": "greeting=hi\n",
          "tool/do.sh": uses("# shellcheck source=tool/lib.inc\n. ./tool/lib.inc"),
        },
        scripts: ["tool/do.sh"],
      },
      {
        name: "a double-quoted helper path with a space is followed",
        files: {
          ".shellcheckrc": "external-sources=true\n",
          "tool/my helper.inc": "greeting=hi\n",
          "tool/do.sh": uses('. "./tool/my helper.inc"'),
        },
        scripts: ["tool/do.sh"],
      },
      {
        name: "a backslash-escaped helper path is followed",
        files: {
          ".shellcheckrc": "external-sources=true\n",
          "tool/my helper.inc": "greeting=hi\n",
          "tool/do.sh": uses(". ./tool/my\\ helper.inc"),
        },
        scripts: ["tool/do.sh"],
      },
      {
        name: "a quoted source= directive names a dynamically sourced helper",
        files: {
          ".shellcheckrc": "external-sources=true\n",
          "tool/my helper.inc": "greeting=hi\n",
          "tool/do.sh": uses('# shellcheck source="tool/my helper.inc"\n. "$HELPER"'),
        },
        scripts: ["tool/do.sh"],
      },
      {
        name: "source-path=SCRIPTDIR resolves a helper beside the script",
        files: {
          ".shellcheckrc": "external-sources=true\nsource-path=SCRIPTDIR\n",
          "tool/lib.inc": "greeting=hi\n",
          "tool/do.sh": uses(". lib.inc"),
        },
        scripts: ["tool/do.sh"],
      },
      {
        name: "without external-sources, a sourced helper is not followed in either read",
        files: { "tool/lib.inc": "greeting=hi\n", "tool/do.sh": uses(". ./tool/lib.inc") },
        scripts: ["tool/do.sh"],
      },
    ]

    /** The blocking verdict as a reader sees it: exit status, and each finding with its place.
     * Both runs speak gcc format — the hook's one run prints blocking and advice lines alike, so
     * the verdict keeps only the blocking severities (warning, error) to compare. */
    function verdict(code: number, stdout: string) {
      const lines = stdout.split("\n").filter((l) => /^\.\/.*:\d+:\d+: (warning|error): /.test(l))
      return { failed: code !== 0, findings: lines.map((l) => l.trim()).sort() }
    }

    for (const row of rows) {
      const test = row.gap ? it.fails : it
      test(`${row.name}${row.gap ? ` — known gap, ${row.gap}` : ""}`, async () => {
        await baseRepo()
        for (const [rel, body] of Object.entries(row.files)) await write(rel, body)
        await commitAll("chore: the row's files")
        await gates()
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-parity-home-"))
        const env = await stubEnv({ HOME: home, XDG_CONFIG_HOME: home })

        const hook = await runPrePush(
          env,
          update("main", await revParse("HEAD"), await revParse("HEAD~1")),
        ).then(
          (r) => verdict(0, r.stdout),
          (e) => verdict(e.code ?? 1, e.stdout ?? ""),
        )

        const checkout = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-parity-checkout-"))
        await pExecFile("git", ["worktree", "add", "-q", "--detach", checkout, "HEAD"], {
          cwd: dir,
        })
        const reference = await pExecFile(
          "shellcheck",
          ["-S", "warning", "-f", "gcc", "--", ...row.scripts.map((s) => `./${s}`)],
          { cwd: checkout, env },
        ).then(
          (r) => verdict(0, r.stdout),
          (e) => verdict(e.code ?? 1, e.stdout ?? ""),
        )
        await pExecFile("git", ["worktree", "remove", "--force", checkout], { cwd: dir })

        expect(hook).toEqual(reference)
      })
    }
  },
)
