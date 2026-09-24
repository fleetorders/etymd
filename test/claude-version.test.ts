import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The probe's live half, hermetically: execFile is mocked for the WHOLE module graph of this
// file, so no test can ever reach a real binary — not `claude`, not anything else. Nothing in
// this suite calls git, the one other child_process user in the graph.
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const { promisify } = await import("node:util")

  const impl = ((
    file: string,
    args: readonly string[],
    _options: unknown,
    cb: (err: Error | null, result?: { stdout: string }) => void,
  ) => {
    try {
      cb(null, mocks.execFile(file, [...args]) as { stdout: string })
    } catch (err) {
      cb(err as Error)
    }
  }) as unknown as NodeJS.EventEmitter & {
    (file: string, args: readonly string[], cb: (err: Error | null) => void): void
  }
  // promisify(execFile) prefers this symbol; without it the multi-arg callback shape of the
  // real execFile would be mis-read by promisify's default.
  Object.assign(impl, {
    [promisify.custom]: (file: string, args: readonly string[]) =>
      new Promise((resolve) => {
        resolve(mocks.execFile(file, [...args]) as { stdout: string })
      }),
  })
  return { ...actual, execFile: impl }
})

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-claude-version-"))
  mocks.execFile.mockReset()
  vi.resetModules()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(dir, { recursive: true, force: true })
})

// resetModules gives every test a fresh module registry — the version memo is module-level, so
// each test must import its own copy of detect.js and use only that.
const freshDetect = async () => import("../src/core/detect.js")

describe("detectClaudeCodeVersion — the probe", () => {
  it("extracts the numeric triple from noisy `claude --version` output", async () => {
    mocks.execFile.mockReturnValue({ stdout: "2.1.300 (Claude Code)\n" })
    const { detectClaudeCodeVersion } = await freshDetect()
    await expect(detectClaudeCodeVersion()).resolves.toEqual({
      state: "version",
      version: "2.1.300",
    })
    expect(mocks.execFile).toHaveBeenCalledWith("claude", ["--version"])
  })

  it("asks the binary once per process — the second call is memoized", async () => {
    mocks.execFile.mockReturnValue({ stdout: "2.1.300\n" })
    const { detectClaudeCodeVersion } = await freshDetect()
    await detectClaudeCodeVersion()
    await detectClaudeCodeVersion()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })

  it("ENOENT means absent — no Claude Code on the machine", async () => {
    mocks.execFile.mockImplementation(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })
    })
    const { detectClaudeCodeVersion } = await freshDetect()
    await expect(detectClaudeCodeVersion()).resolves.toEqual({ state: "absent" })
  })

  it("a probe that fails any other way is undetermined, not absent", async () => {
    mocks.execFile.mockImplementation(() => {
      throw new Error("spawn claude ETIMEDOUT")
    })
    const { detectClaudeCodeVersion } = await freshDetect()
    const result = await detectClaudeCodeVersion()
    expect(result).toMatchObject({ state: "undetermined" })
    expect(result.state === "undetermined" && result.reason).toContain("failed")
  })

  it("`claude --version` printing no version is undetermined", async () => {
    mocks.execFile.mockReturnValue({ stdout: "version information unavailable\n" })
    const { detectClaudeCodeVersion } = await freshDetect()
    const result = await detectClaudeCodeVersion()
    expect(result).toMatchObject({ state: "undetermined" })
    expect(result.state === "undetermined" && result.reason).toContain("printed no version")
  })
})

describe("detectClaudeCodeVersion — the ETYMD_CLAUDE_VERSION pin", () => {
  it("`none` and empty mean absent, and never launch the probe", async () => {
    const { detectClaudeCodeVersion } = await freshDetect()
    vi.stubEnv("ETYMD_CLAUDE_VERSION", "none")
    await expect(detectClaudeCodeVersion()).resolves.toEqual({ state: "absent" })
    vi.stubEnv("ETYMD_CLAUDE_VERSION", "")
    await expect(detectClaudeCodeVersion()).resolves.toEqual({ state: "absent" })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it("a prerelease pin reads as its numeric triple", async () => {
    vi.stubEnv("ETYMD_CLAUDE_VERSION", "2.1.276-beta")
    const { detectClaudeCodeVersion } = await freshDetect()
    await expect(detectClaudeCodeVersion()).resolves.toEqual({
      state: "version",
      version: "2.1.276",
    })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it("a pin that is not a version is undetermined — never silently current", async () => {
    // The defect this pins: `2.1.x` and `latest` used to reach versionBefore as NaN, which
    // compares as "not before", i.e. current — disabling the old-reader check without a word.
    const { detectClaudeCodeVersion } = await freshDetect()
    for (const bad of ["2.1.x", "latest"]) {
      vi.stubEnv("ETYMD_CLAUDE_VERSION", bad)
      const result = await detectClaudeCodeVersion()
      expect(result, bad).toMatchObject({ state: "undetermined" })
      expect(result.state === "undetermined" && result.reason).toContain(bad)
    }
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
})

describe("checkClaudePointer — an undetermined version is disclosed, not passed", () => {
  it("returns kind undetermined for a bare AGENTS.md when the probe cannot say", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# contract\n", "utf8")
    mocks.execFile.mockImplementation(() => {
      throw new Error("spawn claude ETIMEDOUT")
    })
    const { checkClaudePointer } = await freshDetect()
    const result = await checkClaudePointer(dir)
    expect(result).toMatchObject({ ok: false, kind: "undetermined" })
  })

  it("absent stays a pass — a machine without Claude Code has no reader to warn about", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# contract\n", "utf8")
    mocks.execFile.mockImplementation(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })
    })
    const { checkClaudePointer } = await freshDetect()
    await expect(checkClaudePointer(dir)).resolves.toEqual({ ok: true, via: "native-fallback" })
  })
})
