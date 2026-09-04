import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { run as proposeCmd } from "../src/commands/propose.js"
import { sweep as sweepCmd } from "../src/commands/fleet.js"
import {
  buildProposals,
  parseRubric,
  PROPOSAL_SCHEMA,
  type Proposal,
} from "../src/engine/propose.js"
import type { FleetProjectSweep } from "../src/engine/fleet.js"

const pExecFile = promisify(execFile)

// Synthetic fixtures ONLY — invented names, invented hosts, temp dirs. Nothing here may carry
// real project vocabulary; the sweep underneath reads whatever the fixture repos carry.

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-propose-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

const RUBRIC = [
  "# the fixture fleet's own weights",
  "severity: 2",
  "economy: 3",
  "confidence: 1",
  "breadth: 4",
  "",
].join("\n")

/** A repo with an always-loaded AGENTS.md past the 4000-word per-file budget. */
async function initHeavyRepo(rel: string, words = 4600) {
  await pExecFile("git", ["init", "-q", path.join(dir, rel)])
  await write(path.join(rel, "AGENTS.md"), `${"word ".repeat(words)}\n`)
  await write(path.join(rel, "src.txt"), "code\n")
  const cwd = path.join(dir, rel)
  await pExecFile("git", ["add", "-A"], { cwd })
  await pExecFile("git", ["commit", "-q", "--no-verify", "-m", "fixture"], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fx@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fx@example.invalid",
    },
  })
}

async function writeHub(
  projects: unknown[],
  local: Record<string, unknown> | null = { machineProfile: "personal", dirs: {} },
) {
  await write(
    "hub/registry.json",
    JSON.stringify({ registryVersion: 1, root: "..", projects }, null, 2) + "\n",
  )
  if (local !== null) {
    await write("hub/registry.local.json", JSON.stringify(local, null, 2) + "\n")
  }
  return path.join(dir, "hub", "registry.json")
}

const personal = (name: string) => ({
  name,
  kind: "repo",
  profile: "personal",
  path: name,
  trust: "private",
  contract: {},
  links: {},
})

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((s: string | Uint8Array): boolean => {
      chunks.push(String(s))
      return true
    })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return chunks.join("")
}

async function proposeJson(
  manifest: string,
): Promise<{ proposals: Proposal[]; disclosures: string[] }> {
  return JSON.parse(
    await captureStdout(() =>
      proposeCmd({
        cwd: path.join(dir, "hub"),
        manifest,
        rubric: path.join(dir, "rubric.txt"),
        json: true,
      }),
    ),
  ) as { proposals: Proposal[]; disclosures: string[] }
}

describe("propose — rubric parsing", () => {
  it("parses labeled lines, skipping comments and blanks", () => {
    const rubric = parseRubric(RUBRIC, "rubric.txt")
    expect(rubric.lines).toEqual([
      { criterion: "severity", weight: 2 },
      { criterion: "economy", weight: 3 },
      { criterion: "confidence", weight: 1 },
      { criterion: "breadth", weight: 4 },
    ])
  })

  it("an unknown criterion is a refusal that names the line", () => {
    expect(() => parseRubric("severity: 2\nvelocity: 5\n", "r.txt")).toThrow(
      /r.txt:2 `velocity: 5` — unknown criterion `velocity`.*severity, economy, confidence, breadth/,
    )
  })

  it("a malformed weight, a duplicate criterion, and an empty rubric are each refused", () => {
    expect(() => parseRubric("severity: lots\n", "r.txt")).toThrow(
      /weight `lots` is not a positive integer/,
    )
    expect(() => parseRubric("no separator here\n", "r.txt")).toThrow(
      /expected `criterion: <weight>`/,
    )
    expect(() => parseRubric("severity: 1\nseverity: 2\n", "r.txt")).toThrow(
      /criterion `severity` is already weighted on line 1/,
    )
    expect(() => parseRubric("# only comments\n\n", "r.txt")).toThrow(/no criterion lines/)
  })
})

describe("propose — the fixture fleet (acceptance)", () => {
  it("emits ≥1 proposal, deterministically, without moving the delta baseline", async () => {
    await initHeavyRepo("alpha")
    await initHeavyRepo("beta")
    await write("rubric.txt", RUBRIC)
    const manifest = await writeHub([personal("alpha"), personal("beta")])

    const first = await proposeJson(manifest)
    expect(first.proposals.length).toBeGreaterThanOrEqual(1)
    // A class open in two projects ranks above its own member findings (breadth fires).
    expect(first.proposals[0]?.id).toBe("class:context-economy/heavy-file")
    expect(first.proposals[0]?.projects).toEqual(["alpha", "beta"])

    const second = await proposeJson(manifest)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    // Read-only: the sweep's delta baseline was not created or moved.
    expect(existsSync(path.join(dir, "hub", "last.fleet.json"))).toBe(false)
  })

  it("scores from a stored sweep exactly as from a fresh one", async () => {
    await initHeavyRepo("alpha")
    await initHeavyRepo("beta")
    await write("rubric.txt", RUBRIC)
    const manifest = await writeHub([personal("alpha"), personal("beta")])

    const stored = await captureStdout(() =>
      sweepCmd({ cwd: path.join(dir, "hub"), manifest, json: true }),
    )
    await write("hub/stored.fleet.json", stored)
    const fromFile = JSON.parse(
      await captureStdout(() =>
        proposeCmd({
          cwd: path.join(dir, "hub"),
          from: path.join(dir, "hub", "stored.fleet.json"),
          rubric: path.join(dir, "rubric.txt"),
          json: true,
        }),
      ),
    ) as Record<string, unknown>
    const fresh = await proposeJson(manifest)
    expect(JSON.stringify(fromFile.proposals)).toBe(JSON.stringify(fresh.proposals))
  })

  it("carries the record shape: class, effort, confidence, matched rubric lines, implications", async () => {
    await initHeavyRepo("alpha")
    await write("rubric.txt", RUBRIC)
    const manifest = await writeHub([personal("alpha")])

    const result = await proposeJson(manifest)
    const finding = result.proposals.find((p) => p.kind === "finding")
    expect(finding).toBeDefined()
    expect(finding?.schema).toBe(PROPOSAL_SCHEMA)
    expect(finding?.class).toBe("context-economy/heavy-file")
    expect(finding?.effort).toBe("M")
    expect(finding?.confidence).toBe("high")
    // gap=2 · M=2 · high=3 · breadth 1 → (2·2)+(3·2)+(1·3)+(4·1) = 17, breadth does not fire.
    expect(finding?.score).toBe(17)
    expect(finding?.matched).toEqual([
      { criterion: "severity", weight: 2, value: 2 },
      { criterion: "economy", weight: 3, value: 2 },
      { criterion: "confidence", weight: 1, value: 3 },
    ])
    expect(finding?.implications).toEqual({
      projects: ["alpha"],
      files: ["AGENTS.md"],
      gates: [],
      reversibility: "git-reversible",
    })
  })

  it("excludes guarded entries from the output entire — findings, classes, and by name", async () => {
    await initHeavyRepo("alpha")
    await initHeavyRepo("beta")
    await write("rubric.txt", RUBRIC)
    const manifest = await writeHub([
      personal("alpha"),
      personal("beta"),
      { name: "c-one", kind: "repo", profile: "guarded", private: true, contract: {}, links: {} },
    ])

    const result = await proposeJson(manifest)
    expect(result.proposals.some((p) => p.projects.includes("c-one"))).toBe(false)
    expect(result.disclosures.some((d) => /guarded entries excluded.*c-one/.test(d))).toBe(true)
  })
})

describe("propose — subject selection (synthetic sweeps)", () => {
  const sweep = (projects: FleetProjectSweep[]) => ({
    manifest: "/synthetic/registry.json",
    projects,
  })

  const project = (
    name: string,
    profile: "personal" | "guarded",
    findings: Partial<import("../src/engine/finding.js").Finding>[],
  ): FleetProjectSweep => ({
    name,
    profile,
    resolvedRoot: `/synthetic/${name}`,
    staleAfterDays: 30,
    stateAgeDays: null,
    counts: { risk: 0, gap: 0, polish: 0 },
    findings: findings.map((f, i) => ({
      id: f.id ?? `lens/class-${i}:${name}`,
      lens: f.lens ?? "lens",
      tier: f.tier ?? "gap",
      kind: f.kind,
      claim: f.claim ?? "claim",
      evidence: f.evidence ?? ["AGENTS.md: 1 word"],
      why: f.why ?? "why",
      action: f.action,
      effort: f.effort ?? "S",
      confidence: f.confidence ?? "high",
    })),
    disclosures: [],
  })

  const rubric = parseRubric("severity: 1\neconomy: 1\nconfidence: 1\nbreadth: 1\n", "r.txt")

  it("truth findings never become proposals — a lie is fixed, not ranked", () => {
    const result = buildProposals(
      sweep([
        project("alpha", "personal", [
          { id: "instruction-truth/lying-command:x", kind: "truth", tier: "risk" },
          { id: "gate-integrity/ci-only-eslint:y", kind: "improvement", tier: "gap" },
        ]),
      ]),
      "r.txt",
      rubric,
    )
    expect(result.proposals.map((p) => p.id)).toEqual(["alpha:gate-integrity/ci-only-eslint:y"])
  })

  it("a class held open only by guarded projects is not this fleet's proposal", () => {
    const result = buildProposals(
      sweep([
        project("c-one", "guarded", [{ id: "context-economy/heavy-file:AGENTS.md" }]),
        project("c-two", "guarded", [{ id: "context-economy/heavy-file:AGENTS.md" }]),
      ]),
      "r.txt",
      rubric,
    )
    expect(result.proposals).toEqual([])
  })

  it("a class aggregates conservatively: worst tier, dearest effort, weakest confidence", () => {
    const result = buildProposals(
      sweep([
        project("alpha", "personal", [
          { id: "x/cls:a", tier: "gap", effort: "S", confidence: "high" },
        ]),
        project("beta", "personal", [
          { id: "x/cls:b", tier: "risk", effort: "L", confidence: "low" },
        ]),
      ]),
      "r.txt",
      rubric,
    )
    const cls = result.proposals.find((p) => p.kind === "class")
    expect(cls).toBeDefined()
    expect(cls?.effort).toBe("L")
    expect(cls?.confidence).toBe("low")
    // severity=3 fires; economy L=1 and confidence low=1 do not; breadth 2 fires.
    expect(cls?.matched.map((m) => m.criterion)).toEqual(["severity", "breadth"])
  })

  it("gate surfaces land in implications.gates; generated-only paths read regenerable", () => {
    const result = buildProposals(
      sweep([
        project("alpha", "personal", [
          {
            id: "gate-integrity/ci-only-eslint:y",
            kind: "improvement",
            evidence: [".github/workflows/ci.yml job `build`", "local hooks (githooks)"],
          },
        ]),
      ]),
      "r.txt",
      rubric,
    )
    expect(result.proposals[0]?.implications).toEqual({
      projects: ["alpha"],
      files: [".github/workflows/ci.yml"],
      gates: [".github/workflows/ci.yml"],
      reversibility: "git-reversible",
    })

    const regen = buildProposals(
      sweep([
        project("alpha", "personal", [
          { id: "z/cls:a", kind: "improvement", evidence: [".githooks/pre-push: regenerated"] },
        ]),
      ]),
      "r.txt",
      rubric,
    )
    expect(regen.proposals[0]?.implications.reversibility).toBe("regenerable")
  })

  it("an unknown rubric criterion refuses at the command edge, naming the line", async () => {
    await initHeavyRepo("alpha")
    await write("rubric.txt", "severity: 2\nvelocity: 5\n")
    const manifest = await writeHub([personal("alpha")])
    await expect(
      proposeCmd({
        cwd: path.join(dir, "hub"),
        manifest,
        rubric: path.join(dir, "rubric.txt"),
        json: true,
      }),
    ).rejects.toThrow(/rubric.txt:2 `velocity: 5` — unknown criterion/)
  })
})
