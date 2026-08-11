import { describe, expect, it } from "vitest"

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { isSelfName, patternLiteral, readScreenable, screenText } from "../src/commands/screen.js"

const patterns = [/AcmeInc/i, /internal\.example\.com/i]

describe("content screen", () => {
  it("flags a pattern hit and an absolute home path, with the line number", () => {
    const home = `/${"Users"}/someone/projects/x` // a fixture, assembled so it is not a literal
    const text = ["clean line", "mentions AcmeInc here", home].join("\n")
    const hits = screenText(text, "doc.md", patterns)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ file: "doc.md", line: 2 })
    expect(hits[1]).toMatchObject({ line: 3, reason: "absolute home path" })
  })

  it("is case-insensitive — a leak does not stop being one in lower case", () => {
    expect(screenText("acmeinc", "f", patterns)).toHaveLength(1)
  })

  it("PINNED: a line marked `allow-published-string` is exempt", () => {
    // The escape hatch has to be visible IN the diff — a reviewer sees the exemption being
    // granted rather than discovering a silent allowlist elsewhere.
    const hits = screenText("AcmeInc on purpose allow-published-string", "f", patterns)
    expect(hits).toEqual([])
  })

  it("reports one hit per line, not one per matching pattern", () => {
    // Otherwise a line matching three patterns triples the noise for a single fix.
    const hits = screenText("AcmeInc and internal.example.com together", "f", patterns)
    expect(hits).toHaveLength(1)
  })

  it("matches a home path under either /Users or /home", () => {
    // Assembled from parts so this suite does not trip the very screen it tests (and so a
    // repo-wide grep for machine paths does not flag its own fixtures).
    const under = (root: string) => `/${root}/someone/x`
    expect(screenText(under("home"), "f", [])).toHaveLength(1)
    expect(screenText(under("Users"), "f", [])).toHaveLength(1)
    // Not every path is a machine path — /usr/local and repo-relative paths must stay silent.
    expect(screenText("/usr/local/bin/tool", "f", [])).toEqual([])
    expect(screenText("src/core/util.ts", "f", [])).toEqual([])
  })

  it("finds nothing when there is nothing — no patterns means no findings", () => {
    expect(screenText("AcmeInc everywhere", "f", [])).toEqual([])
  })

  it("honours repo-level allow patterns for lines that cannot carry an inline marker", () => {
    // A scanner's own source contains the strings it screens for, and a bundler strips
    // comments — so some exemptions cannot live on the line itself.
    const allow = [/describing its own check/i]
    expect(screenText("AcmeInc, describing its own check", "f", patterns, allow)).toEqual([])
    // The exemption is narrow: an ordinary hit beside it still reports.
    expect(screenText("AcmeInc in plain prose", "f", patterns, allow)).toHaveLength(1)
  })

  it("an allow pattern suppresses a machine path too, not just a listed pattern", () => {
    const home = `/${"Users"}/someone/x`
    expect(screenText(home, "f", [], [/someone/])).toEqual([])
  })
})

describe("self-name exemption", () => {
  it("drops a pattern that IS the repo's own name, keeps one that merely contains it", () => {
    // A repo has to call itself something in its own README and package name; the
    // cross-project rule is about disclosing OTHER projects.
    expect(isSelfName(/widget/i, ["widget"])).toBe(true)
    expect(isSelfName(/WIDGET/i, ["widget"])).toBe(true)
    // Narrower than the name, or broader than it, both stay active.
    expect(isSelfName(/widget-internal/i, ["widget"])).toBe(false)
    expect(isSelfName(/wid/i, ["widget"])).toBe(false)
  })

  it("PINNED: word-anchored spelling of the same name is still the same name", () => {
    // The regression this pins: a pattern generator started emitting names word-anchored, the
    // exemption compared raw sources, and every self-name silently stopped being exempt — code,
    // comment and test all still reading as correct while repos began reporting their own
    // manifests as leaks. Anchors change where a match may begin, never WHICH string matches.
    expect(isSelfName(/\bwidget\b/i, ["widget"])).toBe(true)
    expect(isSelfName(/\bwidget/i, ["widget"])).toBe(true)
    expect(isSelfName(/widget\b/i, ["widget"])).toBe(true)
    // And still no wider: anchoring a DIFFERENT name does not make it the repo's own.
    expect(isSelfName(/\bgadget\b/i, ["widget"])).toBe(false)
  })

  it("exempts any of the names the repo can prove are its own, and nothing else", () => {
    // Directory, package name and remote basename routinely disagree; each is proof of identity.
    const selves = ["widget", "widget-app", "widget.js"]
    expect(isSelfName(/\bwidget-app\b/i, selves)).toBe(true)
    expect(isSelfName(/\bwidget\.js\b/i, selves)).toBe(true) // escaped metacharacter, still literal
    expect(isSelfName(/\bgadget\b/i, selves)).toBe(false)
    // No provable identity means no exemption — a repo that cannot say what it is gets screened
    // in full rather than trusted.
    expect(isSelfName(/\bwidget\b/i, [])).toBe(false)
  })

  it("never exempts a pattern broader than a single name, however it is spelled", () => {
    // A pattern that can match more than one string is not a name, so it can never be proven to
    // be THIS repo's name — the exemption would be wider than the thing it exempts.
    expect(isSelfName(/wid(get)?/i, ["widget"])).toBe(false)
    expect(isSelfName(/widget|gadget/i, ["widget"])).toBe(false)
    expect(isSelfName(/widge./i, ["widget"])).toBe(false)
    expect(isSelfName(/widget+/i, ["widget"])).toBe(false)
    expect(isSelfName(/widge[t]/i, ["widget"])).toBe(false)
    expect(patternLiteral("widget\\d")).toBeNull()
    expect(patternLiteral("wid\\bget")).toBeNull() // an anchor mid-pattern is not a literal
    expect(patternLiteral("\\bwidget\\b")).toBe("widget")
  })
})

describe("binary files are skipped, not screened", () => {
  // The defect this closes: compressed bytes contain any short sequence
  // eventually, so a short pattern matches inside a binary asset and is reported
  // as a "line" of mojibake. The cost of that noise is not the noise; it is that
  // the gate's answer becomes "bypass again", and a trained-in bypass is what
  // eventually waves a real finding through with the rest.
  const tmp = () => path.join(os.tmpdir(), `etymd-screen-${Math.random().toString(36).slice(2)}`)

  it("reports a file carrying a NUL byte as binary rather than screening its bytes", async () => {
    const f = tmp()
    // A real leak string sits AFTER the NUL, so a screen that reads this file at
    // all would flag it. Skipping is the only way this test passes.
    await fs.writeFile(
      f,
      Buffer.concat([Buffer.from("\x89PNG\r\n"), Buffer.from([0]), Buffer.from("AcmeInc")]),
    )
    expect(await readScreenable(f)).toBe("binary")
    await fs.rm(f, { force: true })
  })

  it("still returns text for a file with no NUL, so the gate does not go blind", async () => {
    const f = tmp()
    await fs.writeFile(f, "Copyright (c) AcmeInc\n")
    const out = await readScreenable(f)
    expect(out).not.toBe("binary")
    expect(screenText(String(out), "notice.txt", patterns)).toHaveLength(1)
    await fs.rm(f, { force: true })
  })

  it("returns null for a file that does not exist — distinct from binary, so the skip can be counted", async () => {
    expect(await readScreenable(tmp())).toBeNull()
  })
})
