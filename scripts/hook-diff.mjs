#!/usr/bin/env node
// hook-diff.mjs — replay real commits through two versions of the generated pre-push shellcheck
// step and report every difference in what they read, what they found, and whether they passed.
//
// Unit tests pin the cases someone thought of. A change to how the step reads a commit can drop
// something the old read provided implicitly — a config file beside the scripts, a sourced
// helper — and no test names what nobody thought of. Replaying the recent history of real repos
// through the old and the new step, and explaining every difference, is the check that does.
// Run it before releasing any pack that changes the step.
//
// Usage:
//   node scripts/hook-diff.mjs --old <dir> --new <dir> [--commits N] <repo>...
// where each <dir> holds a generated `pre-push` and its `discover-shell-scripts.sh`. Each repo
// is read, never written: its last N first-parent commits (default 20) are each pushed, as a
// single-commit update, through both steps. Exit 0 = no difference, 1 = differences, 2 = usage or nothing compared.
//
// Only the shellcheck section of each hook runs — the section from "# Shell correctness." to
// the `fi` closing its "shellcheck skipped" branch — so a repo's other gates (tests, audits)
// never run here. A recording `shellcheck` first on PATH logs the files each blocking pass
// received, then hands over to the real one.
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

function usage(message) {
  if (message) console.error(`hook-diff: ${message}`)
  console.error("usage: node scripts/hook-diff.mjs --old <dir> --new <dir> [--commits N] <repo>...")
  process.exit(2)
}

const args = process.argv.slice(2)
const opts = { commits: 20, repos: [] }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--old" || a === "--new") opts[a.slice(2)] = args[++i]
  else if (a === "--commits") opts.commits = Number(args[++i])
  else if (a.startsWith("--")) usage(`unknown option ${a}`)
  else opts.repos.push(a)
}
if (!opts.old || !opts.new || opts.repos.length === 0) usage()
if (!Number.isInteger(opts.commits) || opts.commits < 1) usage("--commits takes a positive integer")

const real = spawnSync("sh", ["-c", "command -v shellcheck"], { encoding: "utf8" }).stdout.trim()
if (!real) usage("shellcheck is not on PATH — there is nothing to compare")

const work = mkdtempSync(path.join(tmpdir(), "hook-diff-"))
process.on("exit", () => rmSync(work, { recursive: true, force: true }))

// The recording checker: one JSON line per blocking pass (-S warning), then the real binary.
const bin = path.join(work, "bin")
execFileSync("mkdir", ["-p", bin])
writeFileSync(
  path.join(bin, "shellcheck"),
  `#!/bin/sh
case " $* " in
  (*" -S warning "*)
    node -e 'const f=process.argv.slice(1).filter(a=>a.startsWith("./")).sort();require("fs").appendFileSync(process.env.HOOK_DIFF_LOG, JSON.stringify(f)+"\\n")' -- "$@" ;;
esac
exec ${JSON.stringify(real)} "$@"
`,
)
chmodSync(path.join(bin, "shellcheck"), 0o755)

/** A runnable copy of one pack's shellcheck step: the section, fed the refs on stdin. */
function stage(label, dir) {
  const hook = readFileSync(path.join(dir, "pre-push"), "utf8").split("\n")
  const start = hook.findIndex((l) => l.startsWith("# Shell correctness."))
  const skip = hook.findIndex((l) => l.includes("shellcheck skipped (not on PATH)"))
  const end = hook.findIndex((l, i) => i > skip && l === "fi")
  if (start < 0 || skip < 0 || end < 0) usage(`${dir}/pre-push has no shellcheck section to run`)
  const pack = hook.map((l) => l.match(/etymd:generated (pack-v\d+)/)?.[1]).find(Boolean) ?? "?"
  const out = path.join(work, label)
  execFileSync("mkdir", ["-p", out])
  writeFileSync(
    path.join(out, "pre-push"),
    ["#!/bin/sh", "refs=$(cat)", ...hook.slice(start, end + 1), ""].join("\n"),
  )
  chmodSync(path.join(out, "pre-push"), 0o755)
  copyFileSync(
    path.join(dir, "discover-shell-scripts.sh"),
    path.join(out, "discover-shell-scripts.sh"),
  )
  chmodSync(path.join(out, "discover-shell-scripts.sh"), 0o755)
  return { label, pack, hook: path.join(out, "pre-push") }
}

const packs = [stage("old", opts.old), stage("new", opts.new)]
console.log(
  `hook-diff: ${packs[0].pack} (old) against ${packs[1].pack} (new), last ${opts.commits} commit(s) per repo`,
)

/** Findings as the reader sees them: every line naming a check code, with its location. */
function findings(stdout) {
  return stdout
    .split("\n")
    .filter((l) => /SC\d{4}/.test(l))
    .map((l) => l.trim())
    .sort()
}

function run(pack, repo, sha, parent) {
  const log = path.join(work, `${pack.label}.jsonl`)
  writeFileSync(log, "")
  const refs = `refs/heads/hook-diff ${sha} refs/heads/hook-diff ${parent}\n`
  const started = Date.now()
  const r = spawnSync(pack.hook, [], {
    cwd: repo,
    input: refs,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOOK_DIFF_LOG: log },
  })
  const read = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => JSON.parse(l))
  return {
    status: r.status,
    read: [...new Set(read)].sort(),
    findings: findings(r.stdout ?? ""),
    ms: Date.now() - started,
    stderr: (r.stderr ?? "").trim(),
  }
}

let differences = 0
let compared = 0
const time = { old: 0, new: 0 }
for (const repo of opts.repos) {
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim()
  let shas
  try {
    shas = git("rev-list", "--first-parent", `--max-count=${opts.commits}`, "HEAD").split("\n")
  } catch {
    console.log(`\n${repo}: not a git repository with commits — skipped`)
    continue
  }
  const lines = []
  for (const sha of shas) {
    let parent
    try {
      parent = git("rev-parse", "--verify", "-q", `${sha}^1`)
    } catch {
      continue // a root commit has no single-commit update to replay
    }
    const [a, b] = packs.map((p) => run(p, repo, sha, parent))
    compared++
    time.old += a.ms
    time.new += b.ms
    const short = sha.slice(0, 8)
    if (a.status !== b.status)
      lines.push(
        `  ${short} exit ${a.status} → ${b.status}${b.stderr ? ` (${b.stderr.split("\n").pop()})` : ""}`,
      )
    const lost = a.read.filter((f) => !b.read.includes(f))
    const gained = b.read.filter((f) => !a.read.includes(f))
    if (lost.length) lines.push(`  ${short} no longer checked: ${lost.join(", ")}`)
    if (gained.length) lines.push(`  ${short} newly checked: ${gained.join(", ")}`)
    const gone = a.findings.filter((f) => !b.findings.includes(f))
    const came = b.findings.filter((f) => !a.findings.includes(f))
    for (const f of gone) lines.push(`  ${short} finding gone: ${f}`)
    for (const f of came) lines.push(`  ${short} finding new:  ${f}`)
  }
  differences += lines.length
  console.log(`\n${repo}: ${lines.length ? `${lines.length} difference(s)` : "identical"}`)
  for (const l of lines) console.log(l)
}
console.log(
  `\nhook-diff: ${compared} commit(s) compared, ${differences} difference(s); ` +
    `time ${(time.old / 1000).toFixed(1)} s old, ${(time.new / 1000).toFixed(1)} s new`,
)
// Nothing compared is not "identical": a run that read no commit proved nothing.
if (compared === 0) usage("no commit was compared — check the repo paths")
process.exit(differences ? 1 : 0)
