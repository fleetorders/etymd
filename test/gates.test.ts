import { execFile, execSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { deflateSync } from "node:zlib"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

const pExecFile = promisify(execFile)

// The built CLI (skipped when dist/ is absent; `npm ci` builds it via `prepare`, so CI has it).
const CLI = path.resolve(import.meta.dirname, "..", "dist", "cli.js")

// The real grep, for stubs that must delegate every invocation but one: a PATH-prepended
// stub cannot `exec grep` without recursing into itself, so the binary is resolved once
// here and baked into the stub. First existing wins; the tests needing it skip without it.
const realGrep = ["/usr/bin/grep", "/bin/grep"].find((p) => existsSync(p)) ?? ""

// The real git, for the same shape of delegating stub. Resolved through the shell because
// git lives elsewhere than the fixed system paths on some setups.
const realGit = (() => {
  try {
    return execSync("command -v git", { encoding: "utf8" }).trim()
  } catch {
    return ""
  }
})()

/** Write a loose object straight into the fixture's object store, bypassing every git writer
 * (mktree and hash-object refuse or fsck the shapes these tests need): the only way to hand
 * the gate a tree entry whose name escapes the tree. */
async function forgeObject(type: string, body: Buffer): Promise<string> {
  const payload = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])
  const sha = createHash("sha1").update(payload).digest("hex")
  const obj = path.join(dir, ".git", "objects", sha.slice(0, 2), sha.slice(2))
  await fs.mkdir(path.dirname(obj), { recursive: true })
  await fs.writeFile(obj, deflateSync(payload))
  return sha
}

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
    // awk is the classifier's matcher: it reads each candidate's interpreter, and a failed
    // read must block like the failed grep it replaced, never pass as "not a shell script".
    ["awk", "etymd: shell script discovery failed"],
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

  it("PINNED: a staged ls-tree record whose path escapes the tree refuses — every consuming arm", async () => {
    // --config, --context and --commit each write tracked bytes into the scratch tree at
    // the record's path; a hand-forged or corrupted tree entry whose name carries .. (git's
    // own writers refuse it, so it can only arrive as a forged object) would write outside
    // the tree the gate built. The guard sits before any byte moves, in every arm that
    // consumes a record path.
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await commitAll("chore: script")
    await gates()
    const discover = path.join(dir, ".githooks", "discover-shell-scripts.sh")
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-staging-tree-"))
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-staging-work-"))
    const sha = await revParse("HEAD")
    const blob = await revParse("HEAD:scripts/run")
    // --context reads this before its record loop; an invocation without it would exit 1
    // for a reason this test is not about.
    await fs.writeFile(path.join(work, "source-names"), "")

    // The control: a plain relative path still stages, as it always has.
    await pExecFile("sh", [discover, "--commit", work, tree, sha, `${sha}:scripts/run`], {
      cwd: dir,
    })
    expect(existsSync(path.join(tree, "scripts", "run"))).toBe(true)

    const escaping = ["../evil.sh", "a/../../evil.sh", "/abs.sh", "./dot.sh"]
    for (const bad of escaping) {
      const res = spawnSync("sh", [discover, "--commit", work, tree, sha, `${sha}:${bad}`], {
        cwd: dir,
        encoding: "utf8",
      })
      expect(res.status, `--commit must refuse ${bad}`).toBe(1)
      expect(res.stderr).toContain("does not stay inside")
    }
    for (const arm of ["--config", "--context"]) {
      const res = spawnSync("sh", [discover, arm, work, tree, `100644 ${blob}\t../evil.sh`], {
        cwd: dir,
        encoding: "utf8",
      })
      expect(res.status, `${arm} must refuse an escaping record path`).toBe(1)
      expect(res.stderr).toContain("does not stay inside")
    }
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

  it("PINNED: a SHELLCHECK_OPTS token carrying a glob reaches the checker verbatim — the strip loop does not expand it", async () => {
    // The unquoted expansion word-splits AND path-expands: a token like pack* was
    // rewritten to whatever the glob matched in the repo root (package.json sits there)
    // before the strip loop ever saw it — the caller's option silently replaced by a
    // filename. Globbing is off for exactly that loop; the word-splitting (one token per
    // word, as the checker reads them itself) stays. The checker stand-in records the
    // SHELLCHECK_OPTS it received, token by token.
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await commitAll("chore: script")
    await gates()
    await stub(
      "shellcheck",
      [
        "#!/usr/bin/env node",
        'if (process.argv.includes("--version")) {',
        '  process.stdout.write("version: 1.0.0\\n")',
        "  process.exit(0)",
        "}",
        'require("node:fs").appendFileSync(process.env.ETYMD_RECORD, JSON.stringify((process.env.SHELLCHECK_OPTS ?? "").split(/ +/)) + "\\n")',
        "process.exit(0)",
        "",
      ].join("\n"),
    )
    const log = path.join(dir, "sc-opts.jsonl")
    const env = await stubEnv({ ETYMD_RECORD: log, SHELLCHECK_OPTS: "pack* --format=gcc extra=1" })

    const { stdout } = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    )
    const tokens = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[])
      .flat()
    // The token survived as itself — not expanded against the repo root.
    expect(tokens).toContain("pack*")
    expect(tokens).not.toContain("package.json")
    // Multi-word still splits, one token per word.
    expect(tokens).toContain("extra=1")
    // The format/severity strip still drops the override and says so out loud.
    expect(tokens).not.toContain("--format=gcc")
    expect(stdout).toContain("SHELLCHECK_OPTS")
  })

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

    it("PINNED: a configured-but-unfetched remote checks the whole history — and says so, never silently skipping", async () => {
      // A remote this clone configured but never fetched passes the name test while
      // --remotes=<name> matches nothing under refs/remotes/<name>/: the bound negates
      // nothing and the range is the whole history. That is the DELIBERATE cost — the
      // wide bound (every remote's refs negated) would let a commit merely fetched from a
      // second remote ship unchecked, the exact hole the "fetched is not gated" pin above
      // guards — so the defect was the SILENCE: a long push with no line saying why. The
      // whole-history read is now named, and a fetched remote still narrows.
      await baseRepo()
      await write("tool/c2.sh", "#!/bin/sh\necho ok\n")
      await commitAll("chore: c2")
      await write("tool/c3.sh", "#!/bin/sh\necho ok\n")
      await commitAll("chore: c3")
      await gates()
      await recordShellcheck()
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })
      const c2 = await revParse("HEAD~1")
      const c3 = await revParse("HEAD")
      // origin: configured AND holding tracking refs; other: another remote holding the
      // tip; backup: configured, never fetched — the shape whose silence was the defect.
      await pExecFile("git", ["remote", "add", "origin", path.join(dir, "bare-origin.git")], {
        cwd: dir,
      })
      await pExecFile("git", ["remote", "add", "backup", path.join(dir, "bare-backup.git")], {
        cwd: dir,
      })
      await pExecFile("git", ["update-ref", "refs/remotes/origin/main", c2], { cwd: dir })
      await pExecFile("git", ["update-ref", "refs/remotes/other/x", c3], { cwd: dir })

      // Pushing a new branch to the unfetched remote: nothing is skipped (other's fetched
      // tip included — fetched is not gated), and the whole-history read is NAMED.
      const { stdout } = await runPrePushRemote(
        env,
        "backup",
        `refs/heads/topic ${c3} refs/heads/topic ${ZERO}`,
      )
      expect(stdout).toContain("3 commit(s) in the pushed range")
      expect(stdout).toContain("configured but not fetched here")

      // The same push naming origin, which HAS tracking refs: the narrow bound negates
      // only origin's refs, so the tip (held by another remote, not origin) IS in the
      // range — and no whole-history line prints.
      const { stdout: narrow } = await runPrePushRemote(
        env,
        "origin",
        `refs/heads/topic ${c3} refs/heads/topic ${ZERO}`,
      )
      expect(narrow).toContain("1 commit(s) in the pushed range")
      expect(narrow).not.toContain("configured but not fetched here")
    })

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

    it("PINNED: the checker stamp is shared by every worktree of the clone — keyed to the common git dir", async () => {
      // --git-dir is per-worktree: a linked worktree had no stamp of its own, read that
      // absence as a first adoption, and a checker upgrade never fired its whole-tree
      // re-read — each worktree baselined its checker independently. The stamp lives in
      // the COMMON git dir: one stamp, one re-baseline, for every worktree of the clone.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      // The gates must exist in the pushed tree: a linked worktree sees only committed
      // files, so the pack is committed before the worktree is created.
      await pExecFile("git", ["add", ".githooks"], { cwd: dir })
      await pExecFile("git", ["commit", "-q", "-m", "chore: commit the gates"], {
        cwd: dir,
        env: GIT_ENV,
      })
      // The common dir carries an OUTDATED stamp — exactly what a checker upgrade leaves
      // behind — while the linked worktree's private dir has none.
      await fs.writeFile(path.join(dir, ".git", "etymd-shellcheck-version"), "0.0.1-old\n")
      const wtPath = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-wt-stamp-"))
      await pExecFile("git", ["worktree", "add", "--detach", wtPath, "HEAD"], { cwd: dir })
      await recordShellcheck("1.2.3")
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "shellcheck.jsonl") })
      const head = await revParse("HEAD")
      const refsFile = path.join(dir, ".pushed-refs")
      await fs.writeFile(refsFile, `refs/heads/main ${head} refs/heads/main ${ZERO}\n`)

      const { stdout } = await pExecFile(
        "sh",
        ["-c", 'cd "$1" && exec ".githooks/pre-push" < "$2"', "sh", wtPath, refsFile],
        { cwd: dir, env },
      )
      // The linked worktree's push saw the COMMON stamp and fired the re-baseline line —
      // under a per-worktree stamp it read its own absence and stayed silent.
      expect(stdout).toContain("the checker changed (0.0.1-old → 1.2.3)")
    })

    it("PINNED: a push with nothing in range does not consume the checker-change re-baseline", async () => {
      // The stamp was written after the per-commit loop whether or not the loop ran. A
      // deletes-only push (or a terminal run, or a rollback) read nothing, yet baselined the
      // new checker version — the next real push then skipped the whole-surface re-read.
      await baseRepo()
      await write("tool/do.sh", "#!/bin/sh\necho ok\n")
      await commitAll("chore: a script")
      await gates()
      await recordShellcheck("1.0.0")
      const log = path.join(dir, "shellcheck.jsonl")
      await runPrePush(
        await stubEnv({ ETYMD_RECORD: log }),
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )

      await recordShellcheck("2.0.0")
      const env = await stubEnv({ ETYMD_RECORD: log })
      const deletes = await runPrePush(
        env,
        `refs/heads/gone ${ZERO} refs/heads/gone ${await revParse("HEAD")}`,
      )
      expect(deletes.stdout).toContain("nothing to check")

      await write("docs/notes.md", "# Notes\n")
      await commitAll("docs: no script touched")
      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("the checker changed (1.0.0 → 2.0.0)")
      expect(stdout).toContain("whole tree")
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
      // A counting repo-owned guard, so the manual run's .local feed is observable: zero
      // records and immediate EOF is the contract (see the empty-pipe test below it).
      await fs.writeFile(
        path.join(dir, ".githooks", "pre-push.local"),
        [
          "#!/bin/sh",
          'printf "start\\n" >> "$ETYMD_RECORD"',
          "n=0",
          "while IFS= read -r line; do n=$((n+1)); done",
          'printf "records %s\\n" "$n" >> "$ETYMD_RECORD"',
          "",
        ].join("\n"),
      )
      await fs.chmod(path.join(dir, ".githooks", "pre-push.local"), 0o755)
      const env = await stubEnv({ ETYMD_RECORD: path.join(dir, "local-records.log") })
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
      // The vacuous run cannot masquerade as a passed push: the last line says what the
      // exit code is actually worth, and the repo-owned guard saw zero records (not the
      // one blank line an empty-string feed would have delivered).
      expect(out).toContain("this exit 0 carries no verdict")
      const localLog = await fs.readFile(path.join(dir, "local-records.log"), "utf8")
      expect(localLog).toContain("records 0")
    })

    it("PINNED: a manual run feeds the repo-owned guard zero records, not one blank", async () => {
      // An empty refs feed reached the guard as `printf '%s\n' "" | guard` — one blank
      // line, where git itself never sends one: a strictly-parsing guard read ONE
      // malformed record on a run that checked nothing, and a stdin-reading guard would
      // have waited on the keyboard the capture exists to avoid. The empty case now hands
      // the guard /dev/null: a true EOF, at once. The terminal run above covers the -t 0
      // branch; this run covers the same downstream branch through an empty piped stdin.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      const log = path.join(dir, "local-records.log")
      await fs.writeFile(
        path.join(dir, ".githooks", "pre-push.local"),
        [
          "#!/bin/sh",
          'printf "start\\n" >> "$ETYMD_RECORD"',
          "n=0",
          "while IFS= read -r line; do n=$((n+1)); done",
          'printf "records %s\\n" "$n" >> "$ETYMD_RECORD"',
          "",
        ].join("\n"),
      )
      await fs.chmod(path.join(dir, ".githooks", "pre-push.local"), 0o755)
      const env = await stubEnv({ ETYMD_RECORD: log })

      // Empty refs (stdin open, empty — not a terminal): zero records, immediate EOF.
      await runPrePush(env)
      const first = await fs.readFile(log, "utf8")
      expect(first).toContain("start")
      expect(first).toContain("records 0")

      // A piped-refs run still delivers one well-formed record per pushed ref.
      await runPrePush(env, update("main", await revParse("HEAD"), await revParse("HEAD~1")))
      const second = await fs.readFile(log, "utf8")
      expect(second).toContain("records 1")
    })
  },
)

describe.skipIf(!existsSync(CLI))("etymd gates — the pushed refs themselves", () => {
  it("PINNED: a failed stdin read refuses the push rather than gating over nothing", async () => {
    // `refs=$(cat)` never checked the read's status: a directory fd fails cat with
    // "stdin: Is a directory", yields empty refs, and every gate below ran green over
    // nothing — against the hook's own rule that an enumeration it could not read
    // refuses. The directory fd is opened here (a shell's own `< dir` redirect is
    // refused at open on some shells, but cat's read of an open fd fails exactly as it
    // would inside the hook).
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await commitAll("chore: script")
    await gates()
    const env = await stubEnv()
    const dirfd = openSync(dir, "r")
    try {
      const res = spawnSync("sh", [".githooks/pre-push"], {
        cwd: dir,
        env,
        stdio: [dirfd, "pipe", "pipe"],
        encoding: "utf8",
      })
      expect(res.status).toBe(1)
      expect(res.stderr).toContain("could not read the pushed refs from stdin")
    } finally {
      closeSync(dirfd)
    }
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
    // The checked set: sh, bash, dash — zsh has its own arm, never the checked one. The
    // patterns live in the classifier file, which is the point: the hook delegates, the helper
    // classifies.
    const checkedArm = classifier.split("\n").find((l) => l.trim().startsWith("(sh|bash|dash"))
    expect(checkedArm).toBeDefined()
    expect(checkedArm).not.toContain("zsh")
    expect(classifier).toContain("(zsh|")
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

  it("a versioned or suffixed interpreter lands in its family", async () => {
    // Three near-duplicate patterns matched the interpreter by its exact name, so bash5 and
    // zsh5 fell through to the "other" bucket: a bash script went unchecked, a zsh one was
    // announced as some other shell. The name is now read once and classified by family.
    await baseRepo()
    await write("tool/five.sh", "#!/usr/local/bin/bash5\necho ok\n")
    await write("tool/split.sh", "#!/usr/bin/env -S bash -e\necho ok\n")
    await write("tool/plain.sh", "#!/bin/sh\necho ok\n")
    await write("tool/five.zsh", "#!/bin/zsh5\necho hi\n")
    await write("tool/dotted.zsh", "#!/bin/zsh-5.9\necho hi\n")
    await commitAll("chore: versioned shells")
    await gates()
    await recordShellcheck()
    const log = path.join(dir, "shellcheck.jsonl")
    const env = await stubEnv({ ETYMD_RECORD: log })

    const { stdout } = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    )
    const calls = await recorded()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.filter((arg) => arg.startsWith("./")).sort()).toEqual([
      "./tool/five.sh",
      "./tool/plain.sh",
      "./tool/split.sh",
    ])
    expect(stdout).toContain("2 zsh script(s) excluded")
    expect(stdout).not.toContain("another interpreter")
  })

  it("PINNED: Node and Python tools are not a shell coverage hole; a ksh script still is", async () => {
    // The bare `#!` catch-all put every non-sh shebang in the "other" bucket, so a repo with
    // Node and Python tools printed a standing "N script(s) under another interpreter (ksh,
    // ash, …)" line on every push for scripts that were never shell — a line pushers learn to
    // ignore, the opposite of what an announced hole is for.
    await baseRepo()
    await write("tool/do.sh", "#!/bin/sh\necho ok\n")
    await write("tool/build.mjs", "#!/usr/bin/env node\nconsole.log(1)\n")
    await write("tool/report.py", "#!/usr/bin/env python3\nprint(1)\n")
    await write("tool/legacy.pl", "#!/usr/bin/perl -w\nprint 1;\n")
    await commitAll("chore: mixed tools")
    await gates()
    await recordShellcheck()
    const log = path.join(dir, "shellcheck.jsonl")
    const env = await stubEnv({ ETYMD_RECORD: log })

    const first = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    )
    expect(first.stdout).not.toContain("another interpreter")
    expect((await recorded())[0]?.filter((arg) => arg.startsWith("./"))).toEqual(["./tool/do.sh"])

    await write("tool/run.ksh", "#!/bin/ksh\necho hi\n")
    await write("tool/more.mjs", "#!/usr/bin/env node\nconsole.log(2)\n")
    await commitAll("chore: a ksh tool")
    const second = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    )
    expect(second.stdout).toContain("1 script(s) under another interpreter")
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

/** The shellcheck verdict read, against checker stand-ins that speak — or refuse to speak —
 * each output shape the gate must classify. Four folds of one verdict line were filed the
 * same night: a broken grep read as "no findings" (its `|| true` folded failure into
 * no-match), a run that exited nonzero while saying NOTHING read as clean (a failed cd
 * checked no script at all), a severity word the patterns do not know shipped real findings
 * as advice, and any stderr byte refused a push the findings had cleared. */
describe.skipIf(!existsSync(CLI) || !realGrep)(
  "etymd gates — the verdict refuses what it cannot read",
  () => {
    /** A checker stand-in with a chosen stdout/stderr/exit shape. --version answers like the
     * real checker (the re-baseline probe calls it once per push, never as a check). */
    async function sayShellcheck(out: string, code: number, err = "") {
      await stub(
        "shellcheck",
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then printf "version: 1.0.0\\n"; exit 0; fi',
          `printf '%s\\n' '${out}'`,
          err ? `printf '%s\\n' '${err}' >&2` : ":",
          `exit ${code}`,
          "",
        ].join("\n"),
      )
    }

    it("PINNED: a grep that fails while reading the verdict refuses the push — a broken reader is not a clean verdict", async () => {
      // The defect: `blocking=$(printf … | grep -E … || true)` folded grep's failure (2 or
      // more) into its no-match verdict (1), so a broken grep passed a push carrying a real
      // warning. The stub fails ONLY the verdict read — the one grep invoked as `-E <the
      // anchored blocking pattern>`; every other grep in the hook (discovery, the run_gate
      // scrub, the advice complement) sees different arguments and reaches the real binary.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      await sayShellcheck("./scripts/run:1:6: warning: forced finding [SC0000]", 1)
      await stub(
        "grep",
        [
          "#!/bin/sh",
          'case "$1" in',
          '  (-E) case "$2" in ("^[^:]+:"*) echo "forced verdict-reader failure" >&2; exit 2 ;; esac ;;',
          "esac",
          `exec "${realGrep}" "$@"`,
          "",
        ].join("\n"),
      )
      const env = await stubEnv()

      await expect(
        runPrePush(env, update("main", await revParse("HEAD"), await revParse("HEAD~1"))),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("could not read the shellcheck verdict"),
      })
    })

    it("PINNED: a run that exits nonzero saying nothing refuses — nothing was checked, not nothing was found", async () => {
      // The failed-cd shape: `out=$( cd "$tree" && … xargs shellcheck … 2> err )` — when the
      // cd fails, stdout is empty AND the 2> redirect never ran, so the old verdict saw rc 1,
      // empty everything, and passed. A legal advice-bearing run always has stdout; nonzero
      // with nothing on either stream is doubt, and doubt blocks.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      await sayShellcheck("", 1)
      const env = await stubEnv()

      await expect(
        runPrePush(env, update("main", await revParse("HEAD"), await revParse("HEAD~1"))),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("cannot read as findings"),
      })
    })

    it("a run with advice-level findings still passes, and shows them below the bar", async () => {
      // Doubt must not swallow advice: the checker exits 1 for findings of ANY level, and a
      // note-level line parses as a finding line, so the run passes with its advice shown.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      await sayShellcheck("./scripts/run:2:1: note: forced advice [SC0000]", 1)
      const env = await stubEnv()

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("style/info (not blocking)")
      expect(stdout).toContain("forced advice")
    })

    it("PINNED: advice on a finding-shaped PATH no longer blocks — the blocking read is anchored", async () => {
      // A script named "p:12:3: warning:s.sh" carrying a note-level finding rendered as
      // "p:12:3: warning:s.sh:2:6: note: …" — the old UNanchored pattern matched ":12:3:
      // warning:" inside the PATH field and refused a push over advice. The anchored read
      // starts at the beginning of the line, so the path's own shape cannot cross the bar.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      await sayShellcheck(
        "p:12:3: warning:s.sh:2:6: note: Double quote to prevent globbing [SC2086]",
        1,
      )
      const env = await stubEnv()

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("style/info (not blocking)")
      expect(stdout).toContain("SC2086")
    })

    it("PINNED: a severity word the gate does not know refuses the push — a renamed level must not ship findings as advice", async () => {
      // Severity drift: a future checker renaming or adding a level prints real findings on
      // stdout, exits nonzero, writes nothing to stderr — and every fold of the old verdict
      // passed them as advice, because the blocking pattern no longer matched the word. The
      // doubt read accepts the severities the checker is known to emit; anything else refuses.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      await sayShellcheck(
        "./scripts/run:2:6: fatal: unset_var is referenced but not assigned. [SC2154]",
        1,
      )
      const env = await stubEnv()

      const failure = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      ).then(
        () => {
          throw new Error("expected the drifted severity to refuse the push")
        },
        (error) => error,
      )
      expect(failure.code).toBe(1)
      expect(failure.stdout).toContain("cannot read as findings")
      // The unread finding is shown, not swallowed.
      expect(failure.stdout).toContain("fatal:")
    })

    it("PINNED: stderr without a failure is a diagnosis, not a verdict — a clean-exiting checker does not stop the push", async () => {
      // The old rule refused on any stderr byte whatever the exit status, so checker noise on
      // a clean run was an unblockable stop (no inline directive silences stderr). stderr now
      // prints under a refusal when the run failed, and as a named note when it did not —
      // never as the verdict itself.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      await sayShellcheck("", 0, "checker chatter on stderr")
      const env = await stubEnv()

      const { stdout } = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      )
      expect(stdout).toContain("diagnosis, not a verdict")
      expect(stdout).toContain("checker chatter on stderr")
    })

    it("a warning-level finding in gcc format still refuses, with the way out", async () => {
      // The control for every tightening above: a plain warning on a plain path crosses the
      // anchored bar, and the refusal keeps its remedy line.
      await baseRepo()
      await write("scripts/run", "#!/bin/sh\necho ok\n")
      await commitAll("chore: script")
      await gates()
      await sayShellcheck("./scripts/run:1:6: warning: forced finding [SC0000]", 1)
      const env = await stubEnv()

      const failure = await runPrePush(
        env,
        update("main", await revParse("HEAD"), await revParse("HEAD~1")),
      ).then(
        () => {
          throw new Error("expected the warning to block the push")
        },
        (error) => error,
      )
      expect(failure.code).toBe(1)
      expect(failure.stdout).toContain("forced finding")
      expect(failure.stdout).toContain("fix, or justify inline")
    })
  },
)

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

  it("pre-push names the refusal a configuration error, and refuses before any long step", async () => {
    // The door used to sit at the end, after the local guard, the package steps and the
    // materialised audit, and said "advisory screen refused" under a comment promising the
    // screen never blocks. It now refuses first, in words that separate the configuration
    // error from the screen's own (advisory) verdict.
    await bareFixture()
    await write(
      ".githooks/pre-push.local",
      '#!/bin/sh\necho ran > "$(dirname "$0")/../LOCAL_RAN"\n',
    )
    await fs.chmod(path.join(dir, ".githooks/pre-push.local"), 0o755)

    const env = { ...process.env, CONTENT_GATE: path.join(dir, "no-such-checker") }
    const run = await door(".githooks/pre-push", [], env)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain("a configuration error refuses the push")
    expect(run.stderr).not.toContain("advisory screen refused")
    expect(existsSync(path.join(dir, "LOCAL_RAN"))).toBe(false)
  })

  it("the way out names any screen-capable checker, not etymd alone", async () => {
    await bareFixture()
    for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
      const text = await fs.readFile(path.join(dir, ".githooks", hook), "utf8")
      expect(text).not.toContain("an executable etymd")
      expect(text).toContain("an executable checker that understands 'screen'")
    }
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

  it("PINNED: a refused audit leaves no worktree registration behind", async () => {
    // The exit trap removed the materialised directory but deregistered the worktree only on
    // the success path, so every refused push left a registration pointing at nothing.
    await baseRepo()
    await write("BLOCK", "1\n")
    await commitAll("chore: a gap the audit refuses")
    await gates()
    const env = await pushEnv()

    await expect(
      runPrePush(env, update("main", await revParse("HEAD"), await revParse("HEAD~1"))),
    ).rejects.toMatchObject({ code: 1 })
    const { stdout } = await pExecFile("git", ["worktree", "list", "--porcelain"], { cwd: dir })
    expect(stdout.split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1)
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

  it("PINNED: an exported GIT_DIR cannot blind the audit — the materialisation runs scrubbed", async () => {
    // git exports GIT_DIR to every hook, and a child git that inherits it ignores its cwd.
    // Unscrubbed, read-tree wrote the pushing checkout's index while the audit tree's stayed
    // empty — the audit's git-scoped enumeration then listed nothing and passed over a tree
    // it never saw (the exact blindness the block comment promises run_gate prevents). The
    // materialisation, the inner blob writes and the removals now all run through the scrub.
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await write("data.txt", "payload\n")
    await commitAll("chore: script and data")
    await gates()
    const log = path.join(dir, "audit-count.log")
    await stub(
      "etymd",
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then printf "version: 0.0.0-stub\\n"; exit 0; fi',
        'printf \'audit %s\\n\' "$(git ls-files | wc -l | tr -d "[:space:]")" >> "$ETYMD_RECORD"',
        "exit 0",
      ].join("\n") + "\n",
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${path.join(dir, ".stub-bin")}${path.delimiter}${process.env.PATH}`,
      ETYMD_RECORD: log,
      // The live shape: an absolute GIT_DIR pointing at this very repo — what a linked
      // worktree's push or a caller's export lands on.
      GIT_DIR: path.join(dir, ".git"),
    }

    const { stdout } = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    )
    expect(stdout).toContain("the pushed tip")
    const logText = await fs.readFile(log, "utf8")
    const auditCount = logText
      .split("\n")
      .find((l) => /^audit \d+$/.test(l.trim()))
      ?.trim()
    // The audit tree's index was filled: ls-files inside the materialised worktree sees the
    // tracked files, so the audit read the tree it was handed.
    expect(auditCount).toBeDefined()
    expect(Number(auditCount?.split(" ")[1])).toBeGreaterThan(0)
  })

  it("PINNED: a failed materialisation prints git's own reason, not a bare refusal", async () => {
    // `worktree add … 2>/dev/null` threw the reason away — a stale lock or a disk condition
    // left the operator with "could not materialise" and nothing to act on. The stub fails
    // ONLY the add; every other git call reaches the real binary.
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await commitAll("chore: script")
    await gates()
    await stub(
      "git",
      [
        "#!/bin/sh",
        'case "$*" in',
        '  (*" worktree add "*) echo "stub: forced worktree add failure" >&2; exit 1 ;;',
        "esac",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    )
    const env = await stubEnv()

    const failure = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    ).then(
      () => {
        throw new Error("expected the failed materialisation to refuse the push")
      },
      (error) => error,
    )
    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain("could not materialise")
    expect(failure.stderr).toContain("git's reason follows")
    expect(failure.stderr).toContain("stub: forced worktree add failure")
  })

  it("PINNED: a failed cleanup after a passed audit names the tree and prints git's reason", async () => {
    // The old success-path remove was `worktree remove --force "$wt" >/dev/null 2>&1 ||
    // exit 1` — checks all green, then a bare nonzero exit with no diagnosis at all. The
    // shellcheck cleanup branch got a naming message in the same era; this path now matches
    // it: the tree, the audited tip, and git's stderr under the refusal.
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await commitAll("chore: script")
    await gates()
    await stub(
      "git",
      [
        "#!/bin/sh",
        'case "$*" in',
        '  (*" worktree remove "*) echo "stub: forced worktree remove failure" >&2; exit 1 ;;',
        "esac",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    )
    const env = await stubEnv()

    const failure = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    ).then(
      () => {
        throw new Error("expected the failed cleanup to refuse the push")
      },
      (error) => error,
    )
    expect(failure.code).toBe(1)
    // The audit itself passed — the refusal is a cleanup failure, and says so.
    expect(failure.stdout).toContain("the pushed tip")
    expect(failure.stderr).toContain("could not remove the audited worktree")
    expect(failure.stderr).toContain("cleanup failed after the audit passed")
    expect(failure.stderr).toContain("stub: forced worktree remove failure")
  })

  it("PINNED: a committed node_modules path stays the commit's — no nested graft of the checkout's live tree", async () => {
    // `ln -s target dir` with an EXISTING directory places the link INSIDE it: a tip that
    // tracked node_modules/committed.json grew a stray $wt/node_modules/node_modules symlink
    // to the checkout's live tree, and the audit read today's installed bytes under the
    // pushed tree's name — neither the commit's nor the intended link's. The link is now
    // skipped when the tip tracks anything under node_modules/ (skip-with-disclosure, the
    // failure mode the block comment already names).
    await baseRepo()
    await write("scripts/run", "#!/bin/sh\necho ok\n")
    await write("node_modules/committed.json", '{"from":"commit"}\n')
    await commitAll("chore: script and a committed node_modules file")
    await gates()
    const log = path.join(dir, "audit-nm.log")
    await stub(
      "etymd",
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then printf "version: 0.0.0-stub\\n"; exit 0; fi',
        '[ -e node_modules/committed.json ] && printf "committed-present\\n" >> "$ETYMD_RECORD"',
        '[ -e node_modules/node_modules ] && printf "nested-link-present\\n" >> "$ETYMD_RECORD"',
        '[ -L node_modules ] && printf "node_modules-is-link\\n" >> "$ETYMD_RECORD"',
        "exit 0",
      ].join("\n") + "\n",
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${path.join(dir, ".stub-bin")}${path.delimiter}${process.env.PATH}`,
      ETYMD_RECORD: log,
    }
    // The checkout HAS a live node_modules (the link would graft without the guard).
    await fs.mkdir(path.join(dir, "node_modules", ".bin"), { recursive: true })

    const { stdout } = await runPrePush(
      env,
      update("main", await revParse("HEAD"), await revParse("HEAD~1")),
    )
    expect(stdout).toContain("the pushed tip")
    const logText = await fs.readFile(log, "utf8")
    expect(logText).toContain("committed-present")
    expect(logText).not.toContain("nested-link-present")
    expect(logText).not.toContain("node_modules-is-link")
  })

  it("PINNED: a tree entry whose name escapes the tree refuses the push — no write outside the audit tree", async () => {
    // git's own writers refuse a tree entry named ../evil.txt, so the object has to be
    // forged straight into the object store — but once it exists, ls-tree emits it verbatim
    // and the materialiser would write OUTSIDE the worktree it just built (a deeper ../
    // chain climbs further). A path the gate cannot safely place is the same class of doubt
    // as a blob it cannot read: refuse. The fixture carries no shell script, so the audit
    // materialiser is the consumer that meets the forged entry.
    await write("package.json", JSON.stringify({ name: "evil", private: true }) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await commitAll("chore: base")
    await gates()
    const env = await stubEnv()
    const blobSha = await forgeObject("blob", Buffer.from("pwned-content\n"))
    const entry = (mode: string, name: string, sha: string) =>
      Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, "hex")])
    const treeSha = await forgeObject(
      "tree",
      Buffer.concat([
        entry("100644", "AGENTS.md", await revParse("HEAD:AGENTS.md")),
        entry("100644", "package.json", await revParse("HEAD:package.json")),
        entry("100644", "../escaped.txt", blobSha),
      ]),
    )
    const commitSha = await forgeObject(
      "commit",
      Buffer.from(
        `tree ${treeSha}\nauthor t <t@example.invalid> 1700000000 +0000\ncommitter t <t@example.invalid> 1700000000 +0000\n\nchore: forged\n`,
      ),
    )
    await pExecFile("git", ["update-ref", "refs/heads/evil", commitSha], { cwd: dir })

    const failure = await runPrePush(
      env,
      `refs/heads/evil ${commitSha} refs/heads/evil ${ZERO}`,
    ).then(
      () => {
        throw new Error("expected the escaping tree entry to refuse the push")
      },
      (error) => error,
    )
    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain("could not materialise")
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

  it("says the README is generated too, and how the screens degrade with no checker", async () => {
    // "Everything except this file" sat above the file's own stamp: a reader taking it as leave
    // to edit got prompted or clobbered by the next run, and a kept edit froze the file. And
    // the silent no-op of a machine with no checker was stated only inside the hooks, never
    // in the file a debugging reader opens first.
    await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await pExecFile("git", ["add", "."], { cwd: dir })

    await gates()
    const readme = (await fs.readFile(path.join(dir, ".githooks/README.md"), "utf8")).replace(
      /\s+/g,
      " ",
    )
    expect(readme).not.toContain("except this file")
    expect(readme).toContain("this README included")
    expect(readme).toContain("silent no-ops by design")
    expect(readme).toContain("set but does not point at an executable checker is loud")
    // Each check names its own dependency: the old "only the `screen` calls need etymd"
    // mis-attributed the truth audit's — a reader without etymd on PATH believed pushes
    // were truth-audited while the audit step skipped with a line.
    expect(readme).not.toContain("only the `screen` calls need etymd")
    expect(readme).toContain("the truth audit needs etymd")
    expect(readme).toContain("shellcheck` on")
  })

  // PINNED: a consumer repo running `prettier --check .` over a fresh install fails without
  // the blank line below — the formatter separates a trailing block-level HTML comment from
  // the paragraph above it. Any byte the formatter would move is a byte the stamp's digest
  // then disagrees with, which reclassifies the file as hand-edited and freezes it out of
  // regeneration; emitting the formatter-stable shape is the only fix that keeps both true.
  it("writes the README in the shape a markdown formatter leaves alone", async () => {
    await write("package.json", JSON.stringify({ name: "demo", private: true }) + "\n")
    await write("AGENTS.md", "# AGENTS.md\n")
    await pExecFile("git", ["add", "."], { cwd: dir })

    await gates()
    const readme = await fs.readFile(path.join(dir, ".githooks/README.md"), "utf8")
    expect(readme.endsWith("\n")).toBe(true)
    const lines = readme.split("\n")
    const stampIndex = lines.findIndex((l) => /^<!-- etymd:generated /.test(l))
    expect(stampIndex).toBe(lines.length - 2)
    expect(lines[stampIndex - 1]).toBe("")
    const { format } = await import("prettier")
    expect(await format(readme, { parser: "markdown" })).toBe(readme)
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
