import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scanProject } from "../src/core/scan.js"
import type { LensContext, LensReport } from "../src/engine/finding.js"
import { parsePinKey, parsePkgAtVersion, pinIntegrityLens } from "../src/lenses/pin-integrity.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-pins-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

async function runPins(): Promise<LensReport> {
  const facts = await scanProject(dir)
  const ctx: LensContext = { root: dir, facts, profile: "solo", baseline: null }
  return pinIntegrityLens.run(ctx)
}

describe("pin key parsing", () => {
  it("parses plain, scoped, ranged, and glob-prefixed keys; rejects nested paths", () => {
    expect(parsePinKey("chalk")).toMatchObject({ name: "chalk" })
    expect(parsePinKey("@scope/chalk")).toMatchObject({ name: "@scope/chalk" })
    expect(parsePinKey("chalk@^4")).toMatchObject({ name: "chalk", range: "^4" })
    expect(parsePinKey("**/chalk")).toMatchObject({ name: "chalk" })
    expect(parsePinKey("parent>child")).toBeNull()
  })

  it("parses pkg@version targets including scoped names and peer suffixes", () => {
    expect(parsePkgAtVersion("tiny@1.0.0")).toEqual({ name: "tiny", version: "1.0.0" })
    expect(parsePkgAtVersion("@scope/tiny@1.0.0")).toEqual({
      name: "@scope/tiny",
      version: "1.0.0",
    })
    // The pnpm caller strips the lock key's leading slash and this drops the peer suffix.
    expect(parsePkgAtVersion("tiny@1.0.0(peer@2.0.0)")).toEqual({ name: "tiny", version: "1.0.0" })
    expect(parsePkgAtVersion("patches/tiny.patch")).toBeNull()
  })
})

describe("pin-integrity lens (npm locks)", () => {
  it("reports an override nothing requests any more, and not one the tree still carries", async () => {
    await write(
      "package.json",
      JSON.stringify({
        name: "shape-demo",
        overrides: { "gone-pkg": "1.0.0", chalk: "5.0.0" },
      }),
    )
    await write(
      "package-lock.json",
      JSON.stringify({
        name: "shape-demo",
        lockfileVersion: 3,
        packages: {
          "": { name: "shape-demo" },
          "node_modules/chalk": { version: "5.0.0" },
        },
      }),
    )

    const report = await runPins()
    expect(report.findings.length).toBe(1)
    expect(report.findings[0]?.id).toBe("pin-integrity/dead-pin:overrides:gone-pkg")
    expect(report.findings[0]?.claim).toContain("nothing in package-lock.json")
    expect(report.findings[0]?.tier).toBe("gap")
  })

  it("counts the manifest's own dependencies as requests", async () => {
    await write(
      "package.json",
      JSON.stringify({
        name: "shape-demo",
        dependencies: { chalk: "^5.0.0" },
        overrides: { chalk: "5.0.0" },
      }),
    )
    await write(
      "package-lock.json",
      JSON.stringify({ name: "shape-demo", lockfileVersion: 3, packages: { "": {} } }),
    )

    const report = await runPins()
    expect(report.findings).toEqual([])
  })

  it("discloses, never flags, when no lockfile can be judged offline", async () => {
    await write("package.json", JSON.stringify({ name: "shape-demo", overrides: { x: "1.0.0" } }))

    const report = await runPins()
    expect(report.findings).toEqual([])
    expect(report.disclosures.some((d) => /no lockfile/.test(d))).toBe(true)
  })
})

describe("pin-integrity lens (pnpm patches)", () => {
  it("reports a patch whose target version the lock no longer carries, in either key direction", async () => {
    await write(
      "package.json",
      JSON.stringify({
        name: "shape-demo",
        pnpm: {
          patchedDependencies: {
            // older shape: patch file is the key
            "patches/tiny@1.0.0.patch": "tiny@1.0.0",
            // newer shape: target is the key
            "big@2.0.0": "patches/big.patch",
          },
        },
      }),
    )
    await write(
      "pnpm-lock.yaml",
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "  /tiny@1.0.0:",
        "    resolution: {integrity: x}",
      ].join("\n"),
    )

    const report = await runPins()
    expect(report.findings.length).toBe(1)
    expect(report.findings[0]?.id).toBe(
      "pin-integrity/dead-patch:pnpm.patchedDependencies: big@2.0.0",
    )
    expect(report.findings[0]?.claim).toContain("patches `big@2.0.0`")
  })

  it("reads pnpm-workspace.yaml patchedDependencies too (where newer pnpm moved them)", async () => {
    await write(
      "pnpm-workspace.yaml",
      ["packages:", "  - apps/*", "patchedDependencies:", "  gone@1.0.0: patches/gone.patch"].join(
        "\n",
      ),
    )
    await write(
      "pnpm-lock.yaml",
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "  /other@1.0.0:",
        "    resolution: {integrity: x}",
      ].join("\n"),
    )

    const report = await runPins()
    expect(report.findings.length).toBe(1)
    expect(report.findings[0]?.id).toBe(
      "pin-integrity/dead-patch:pnpm-workspace.yaml patchedDependencies: gone@1.0.0",
    )
  })
})

describe("pin-integrity lens (yarn resolutions)", () => {
  it("reports a resolution for a package the lock never names, and keeps a live one quiet", async () => {
    await write(
      "package.json",
      JSON.stringify({
        name: "shape-demo",
        resolutions: { "**/chalk": "5.0.0", "**/gone-pkg": "1.0.0" },
      }),
    )
    await write(
      "yarn.lock",
      ["# THIS IS AN AUTOGENERATED FILE.", "", "chalk@^5.0.0:", '  version "5.0.0"'].join("\n"),
    )

    const report = await runPins()
    expect(report.findings.length).toBe(1)
    expect(report.findings[0]?.id).toBe("pin-integrity/dead-pin:resolutions:**/gone-pkg")
  })

  it("verifies range-selective keys by name only, and says so", async () => {
    await write(
      "package.json",
      JSON.stringify({
        name: "shape-demo",
        dependencies: { chalk: "^5.0.0" },
        resolutions: { "chalk@^4": "4.0.0" },
      }),
    )
    await write("yarn.lock", ["chalk@^5.0.0:", '  version "5.0.0"'].join("\n"))

    const report = await runPins()
    expect(report.findings).toEqual([])
    expect(report.disclosures.some((d) => /version selector/.test(d))).toBe(true)
  })
})

describe("pin-integrity lens (nothing declared)", () => {
  it("runs clean with a disclosure when the manifest pins nothing", async () => {
    await write("package.json", JSON.stringify({ name: "shape-demo" }))

    const report = await runPins()
    expect(report.findings).toEqual([])
    expect(report.disclosures.some((d) => /No dependency pins declared/.test(d))).toBe(true)
  })
})
