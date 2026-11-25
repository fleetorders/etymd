import { describe, expect, it } from "vitest"

import {
  isExampleMention,
  isPackagedMention,
  leadWord,
  mentionsOf,
} from "../src/lenses/instruction-truth/comment-context.js"

const before = (text: string, claim: string) => mentionsOf(text, claim).map((m) => m.before)

describe("comment context — where a path is mentioned", () => {
  it("finds whole-token mentions only, with or without a closing slash", () => {
    expect(mentionsOf("see src/x.ts and lib/src/x.ts.", "src/x.ts")).toHaveLength(1)
    expect(mentionsOf("paints `docs/notes/` red", "docs/notes")[0]?.after).toBe("` red")
    expect(mentionsOf("src/x.tsx only", "src/x.ts")).toHaveLength(0)
  })
})

describe("comment context — example mentions", () => {
  it("reads a path behind an example cue as an example", () => {
    expect(
      isExampleMention(before("a path like `docs/notes/` here", "docs/notes")[0] as string),
    ).toBe(true)
    expect(isExampleMention(before("e.g. src/x.ts is promoted", "src/x.ts")[0] as string)).toBe(
      true,
    )
    expect(isExampleMention(before("(for example `./logs.js`)", "./logs.js")[0] as string)).toBe(
      true,
    )
  })

  it("carries the cue across the list it opens, and no further", () => {
    const text = "shapes such as `a/b.ts`, `docs/design/` and `c/d.ts`. Then see e/f.ts"
    expect(isExampleMention(before(text, "docs/design")[0] as string)).toBe(true)
    expect(isExampleMention(before(text, "c/d.ts")[0] as string)).toBe(true)
    expect(isExampleMention(before(text, "e/f.ts")[0] as string)).toBe(false)
  })

  it("bare like and say are prose, not example cues", () => {
    // "the loader looks like `src/gone.ts` used to" and "what the docs say `src/x.ts` holds"
    // cleared real references until the cues required their shapes.
    expect(isExampleMention("the loader looks like ")).toBe(false)
    expect(isExampleMention("what the docs say ")).toBe(false)
    expect(isExampleMention("nothing like ")).toBe(false)
    expect(isExampleMention("a file like ")).toBe(true)
    expect(isExampleMention("files like ")).toBe(true)
    expect(isExampleMention("named like ")).toBe(true)
    expect(isExampleMention("let's say ")).toBe(true)
    expect(isExampleMention("just say ")).toBe(true)
  })

  it("a bracket holding only spans and separators enumerates examples", () => {
    expect(isExampleMention("a longer path (`", "`) is that path's text")).toBe(true)
    expect(isExampleMention("prose — `", "`, `docs/x/` — into spans")).toBe(true)
    expect(isExampleMention("prose — `src/a.ts`, `", "` — into spans")).toBe(true)
    expect(isExampleMention("(see `", "`)")).toBe(false)
    expect(isExampleMention("the map — see `", "` — for details")).toBe(false)
    expect(isExampleMention("(the build script `", "` runs")).toBe(false)
    expect(isExampleMention("the old map — `", "` and more — later")).toBe(false)
  })

  it("a plain reference is not an example", () => {
    expect(isExampleMention("the parser lives in ")).toBe(false)
    expect(isExampleMention("unlike ")).toBe(false)
    expect(isExampleMention("see also ")).toBe(false)
  })
})

describe("comment context — paths inside a built artifact", () => {
  it("everyday words do not place a path inside a built artifact", () => {
    // "in the package" and "in the image" prefix real references in monorepos and asset trees.
    expect(isPackagedMention("the build script in the package ", "")).toBe(false)
    expect(isPackagedMention("the sprite in the image ", "")).toBe(false)
    expect(isPackagedMention("reads ", " back out of the container")).toBe(false)
    expect(isPackagedMention("then reads ", " back out of the APK and refuses")).toBe(true)
  })

  it("reads a path taken out of an artifact as packaged", () => {
    expect(isPackagedMention("then reads ", " back out of the APK and refuses")).toBe(true)
    expect(isPackagedMention("the manifest inside the release bundle, ", "")).toBe(true)
    expect(isPackagedMention("copies ", "` into the image")).toBe(false)
    expect(isPackagedMention("reads ", " in the repo root")).toBe(false)
  })
})

describe("comment context — the word before a path", () => {
  it("returns the word a path directly follows", () => {
    expect(leadWord("order tracks the site (other-repo ")).toBe("other-repo")
    expect(leadWord("see `")).toBe("see")
    expect(leadWord("commit the line: ")).toBeUndefined()
  })

  it("falls back to the previous line's tail only when the path opens its line", () => {
    expect(leadWord("", "commit the appended line with the bump (other-repo")).toBe("other-repo")
    expect(leadWord("see ", "(other-repo")).toBe("see")
  })
})
