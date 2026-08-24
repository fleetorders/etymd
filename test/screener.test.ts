import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { deriveScreenerFindings } from "../src/lenses/gate-integrity/lens.js"
import { probeScreener } from "../src/lenses/gate-integrity/screener.js"
import type { ProjectFacts } from "../src/core/types.js"

let dir: string
const savedGate = process.env.CONTENT_GATE

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-screener-"))
  await fs.mkdir(path.join(dir, ".githooks"), { recursive: true })
})

afterEach(async () => {
  if (savedGate === undefined) delete process.env.CONTENT_GATE
  else process.env.CONTENT_GATE = savedGate
  await fs.rm(dir, { recursive: true, force: true })
})

const facts = () => ({ hooks: { dir: ".githooks" } }) as unknown as ProjectFacts

/** A hook shaped like the pack's: it calls the screen through $GATE. */
async function hookCallingScreen(name = "pre-commit") {
  await fs.writeFile(
    path.join(dir, ".githooks", name),
    '#!/usr/bin/env sh\nGATE="${CONTENT_GATE:-$(command -v etymd || true)}"\nif ! "$GATE" screen --staged; then\n  exit 1\nfi\n',
    "utf8",
  )
}

/** A runner on disk; `answers` decides whether it understands the `screen` subcommand. */
async function runnerThat(answers: boolean): Promise<string> {
  const exe = path.join(dir, answers ? "good-runner" : "foreign-cli")
  const body = answers
    ? "#!/usr/bin/env sh\nexit 0\n"
    : "#!/usr/bin/env sh\necho \"error: unknown command 'screen'\" >&2\nexit 1\n"
  await fs.writeFile(exe, body, "utf8")
  await fs.chmod(exe, 0o755)
  return exe
}

describe("content-screen reachability", () => {
  it("PINNED: a resolved runner that does not understand `screen` is a risk finding", async () => {
    // The class this exists for: the gate resolves to SOMETHING, so it looks configured, but the
    // thing it resolved to cannot screen. Reading the hook can never reveal this.
    await hookCallingScreen()
    process.env.CONTENT_GATE = await runnerThat(false)

    const probe = await probeScreener(dir, facts())
    expect(probe.present).toBe(true)
    expect(probe.answersScreen).toBe(false)

    const disclosures: string[] = []
    const findings = deriveScreenerFindings(probe, disclosures)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.id).toBe("gate-integrity/content-screen-unrunnable")
    expect(findings[0]?.tier).toBe("risk")
    // Truth-kind, so `etymd doctor` (the truth subset) surfaces it, not just a full audit.
    expect(findings[0]?.kind).toBe("truth")
    expect(findings[0]?.evidence).toContain(".githooks/pre-commit")
  })

  it("a runner that answers `screen` is clean", async () => {
    await hookCallingScreen()
    process.env.CONTENT_GATE = await runnerThat(true)

    const probe = await probeScreener(dir, facts())
    expect(probe.answersScreen).toBe(true)
    expect(deriveScreenerFindings(probe, [])).toHaveLength(0)
  })

  it("PINNED: no checker installed is the designed no-op — disclosed, never a finding", async () => {
    // The hook guards on `[ -x "$GATE" ]` precisely so an uninstalled checker is inert. Calling
    // that a defect would flag every machine that never opted in.
    await hookCallingScreen()
    process.env.CONTENT_GATE = path.join(dir, "does-not-exist")

    const probe = await probeScreener(dir, facts())
    expect(probe.answersScreen).toBeNull()

    const disclosures: string[] = []
    expect(deriveScreenerFindings(probe, disclosures)).toHaveLength(0)
    expect(disclosures.join("\n")).toContain("no-op here by design")
  })

  it("a repo whose hooks never call the screen is not probed at all", async () => {
    await fs.writeFile(
      path.join(dir, ".githooks", "pre-commit"),
      "#!/usr/bin/env sh\nnpm run lint || exit 1\n",
      "utf8",
    )
    process.env.CONTENT_GATE = await runnerThat(false)

    const probe = await probeScreener(dir, facts())
    expect(probe.present).toBe(false)
    expect(deriveScreenerFindings(probe, [])).toHaveLength(0)
  })

  it("names every door that calls the screen, not just the first", async () => {
    await hookCallingScreen("pre-commit")
    await hookCallingScreen("pre-push")
    process.env.CONTENT_GATE = await runnerThat(false)

    const probe = await probeScreener(dir, facts())
    expect(probe.doors).toEqual([".githooks/pre-commit", ".githooks/pre-push"])
  })
})
