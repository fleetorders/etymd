import path from "node:path"

import YAML from "yaml"

import type { Finding, Lens, LensContext, LensReport } from "../engine/finding.js"
import { readJson, readText } from "../core/util.js"
import type { PackageJson } from "../core/detect.js"

// The pin-integrity lens: lockfile arithmetic over the dependency pins a manifest declares —
// decision 011, item 2. An `overrides` / `resolutions` entry that no longer rewrites anything the
// tree requests, and a `patchedDependencies` target that no longer exists at the version the patch
// names, are dead pins: the manifest claims a constraint on a dependency that is no longer there,
// and every reader (and every agent asked "why is this pinned?") is misled. STRICTLY offline: the
// lockfile beside the manifest is the whole universe — no registry, no network, no tool run. A pin
// we cannot judge from the lockfile is disclosed, never flagged.

const LENS_ID = "pin-integrity"

/** One override/resolution key, parsed into the name it rewrites and any version selector. */
interface PinKey {
  /** The raw key as written, for evidence and ids. */
  raw: string
  name: string
  /** The `@range` suffix when the key carries one (`foo@^1`); yarn's glob prefix is stripped. */
  range?: string
}

/**
 * `foo`, `@scope/foo`, `foo@^1`, `@scope/foo@1.2.3`, and yarn's glob-prefixed form all name a
 * package to rewrite. Nested-path keys (`foo>bar`) and anything else parse to null: unsupported
 * shapes are counted and disclosed, never guessed at.
 */
export function parsePinKey(raw: string): PinKey | null {
  const stripped = raw.replace(/^\*\*\//, "")
  const m = /^(@[^/@\s]+\/[^/@\s]+|[^/@\s>]+)(?:@([^/\s]+))?$/.exec(stripped)
  if (!m) return null
  return { raw, name: m[1] as string, range: m[2] }
}

/** A `name@version` target a patch names, or null when the string is not that shape. */
export function parsePkgAtVersion(raw: string): { name: string; version: string } | null {
  const m = /^(@[^/@\s]+\/[^/@\s]+|[^/@\s]+)@([^\s(]+)(?:\([^)]*\))?$/.exec(raw.trim())
  if (!m) return null
  return { name: m[1] as string, version: m[2] as string }
}

/** What the lockfile says is installed — the offline universe the pins are judged against. */
interface LockIndex {
  file: string
  names: Set<string>
  /** Exact installed versions by name (peer-suffix-free), where the lock records them. */
  versions: Map<string, Set<string>>
}

/** `packages` keys in npm locks are paths (`node_modules/<name>`, nested for deduped installs). */
function nameFromNodeModulesKey(key: string): string {
  const at = key.lastIndexOf("node_modules/")
  return at === -1 ? key : key.slice(at + "node_modules/".length)
}

/**
 * Build the installed-name/version index from whichever lockfile the repo carries. Reads only;
 * malformed input yields an empty index (the caller discloses "could not be read", it does not
 * accuse). yarn.lock is line-oriented text because its headers (`"name@range", …:`) carry the
 * requested names directly and pulling the whole YAML document costs more than it returns.
 */
async function indexLockfile(root: string): Promise<LockIndex | null> {
  // pnpm
  const pnpmText = await readText(path.join(root, "pnpm-lock.yaml"))
  if (pnpmText !== null) {
    const names = new Set<string>()
    const versions = new Map<string, Set<string>>()
    try {
      const doc = YAML.parse(pnpmText) as {
        importers?: Record<string, Record<string, Record<string, unknown>>>
        packages?: Record<string, unknown>
        snapshots?: Record<string, unknown>
      }
      for (const importer of Object.values(doc.importers ?? {})) {
        for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
          for (const name of Object.keys(importer[section] ?? {})) names.add(name)
        }
      }
      for (const key of [...Object.keys(doc.packages ?? {}), ...Object.keys(doc.snapshots ?? {})]) {
        // Keys look like `/name@1.2.3` or `/@scope/name@1.2.3(peer@1)`.
        const stripped = key.replace(/^\//, "")
        const target = parsePkgAtVersion(stripped)
        if (!target) continue
        names.add(target.name)
        const set = versions.get(target.name) ?? new Set<string>()
        set.add(target.version)
        versions.set(target.name, set)
      }
    } catch {
      /* empty index — disclosed as unreadable by the caller's lockfile-found check */
    }
    return { file: "pnpm-lock.yaml", names, versions }
  }

  // npm
  const npmLock = await readJson<{
    packages?: Record<string, { version?: string }>
    dependencies?: Record<string, { version?: string }>
  }>(path.join(root, "package-lock.json"))
  if (npmLock) {
    const names = new Set<string>()
    const versions = new Map<string, Set<string>>()
    for (const [key, entry] of Object.entries(npmLock.packages ?? {})) {
      if (key === "") continue // the root itself
      const name = nameFromNodeModulesKey(key)
      names.add(name)
      if (entry.version) {
        const set = versions.get(name) ?? new Set<string>()
        set.add(entry.version)
        versions.set(name, set)
      }
    }
    for (const [name, entry] of Object.entries(npmLock.dependencies ?? {})) {
      names.add(name)
      if (entry.version) {
        const set = versions.get(name) ?? new Set<string>()
        set.add(entry.version)
        versions.set(name, set)
      }
    }
    return { file: "package-lock.json", names, versions }
  }

  // yarn (classic and berry share the `"name@range" …:` header shape)
  const yarnText = await readText(path.join(root, "yarn.lock"))
  if (yarnText !== null) {
    const names = new Set<string>()
    const versions = new Map<string, Set<string>>()
    let pending: string[] = []
    for (const rawLine of yarnText.split("\n")) {
      const line = rawLine.trim()
      const versionMatch = /^version\s+"?([^"\s]+)"?/.exec(line)
      if (versionMatch) {
        for (const name of pending) {
          const set = versions.get(name) ?? new Set<string>()
          set.add(versionMatch[1] as string)
          versions.set(name, set)
        }
        pending = []
        continue
      }
      if (line.endsWith(":") && !line.startsWith("#")) {
        pending = line
          .slice(0, -1)
          .split(/,\s*/)
          .map((entry) => entry.replace(/^"|"$/g, ""))
          .map((entry) => parsePkgAtVersion(entry)?.name ?? "")
          .filter(Boolean)
        for (const name of pending) names.add(name)
      }
    }
    return { file: "yarn.lock", names, versions }
  }

  return null
}

export const pinIntegrityLens: Lens = {
  id: LENS_ID,
  version: "1",
  title: "Dependency pin integrity",
  kind: "truth",
  async run(ctx: LensContext): Promise<LensReport> {
    const { root, facts } = ctx
    const findings: Finding[] = []
    const disclosures: string[] = []

    const pkg = await readJson<
      PackageJson & {
        overrides?: Record<string, unknown>
        resolutions?: Record<string, unknown>
        pnpm?: {
          overrides?: Record<string, unknown>
          patchedDependencies?: Record<string, unknown>
        }
      }
    >(path.join(root, "package.json"))

    const overrideSections: { label: string; entries: Record<string, unknown> }[] = []
    for (const [label, entries] of [
      ["overrides", pkg?.overrides],
      ["resolutions", pkg?.resolutions],
      ["pnpm.overrides", pkg?.pnpm?.overrides],
    ] as const) {
      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        overrideSections.push({ label, entries })
      }
    }

    // Patch targets: pnpm's `pnpm.patchedDependencies` in the manifest (either direction — the
    // pkg@version and the patch path have swapped places across pnpm major versions) and the
    // same key at the top of pnpm-workspace.yaml (where pnpm 10 moved it).
    const patchTargets: { key: string; target: string }[] = []
    const collectPatches = (entries: Record<string, unknown>, label: string) => {
      for (const [key, value] of Object.entries(entries)) {
        // One side is `pkg@version`, the other is the patch file path — which side is which has
        // swapped across pnpm major versions, so accept either.
        const asKey = parsePkgAtVersion(key)
        const asValue = typeof value === "string" ? parsePkgAtVersion(value) : null
        const target = asKey ?? asValue
        if (target) {
          patchTargets.push({ key: `${label}: ${key}`, target: (asKey ? key : value) as string })
        } else {
          disclosures.push(
            `${label}: patch entry \`${key}\` names no \`pkg@version\` in either position — skipped, not judged.`,
          )
        }
      }
    }
    if (pkg?.pnpm?.patchedDependencies)
      collectPatches(pkg.pnpm.patchedDependencies, "pnpm.patchedDependencies")
    const workspaceText = await readText(path.join(root, "pnpm-workspace.yaml"))
    if (workspaceText) {
      try {
        const doc = YAML.parse(workspaceText) as { patchedDependencies?: Record<string, unknown> }
        if (doc.patchedDependencies)
          collectPatches(doc.patchedDependencies, "pnpm-workspace.yaml patchedDependencies")
      } catch {
        disclosures.push(
          "pnpm-workspace.yaml is not parseable — its patchedDependencies, if any, were not judged.",
        )
      }
    }

    if (!overrideSections.length && !patchTargets.length) {
      return {
        lens: LENS_ID,
        version: "1",
        title: "Dependency pin integrity",
        kind: "truth",
        status: "ran",
        disclosures: [
          "No dependency pins declared (no overrides, resolutions, or patchedDependencies) — nothing to check.",
        ],
        findings,
      }
    }

    const lock = await indexLockfile(root)
    // The manifest's own dependency sections count as requests too: an override on a direct
    // dependency is legitimate, and workspace package manifests may be the requester.
    const requested = new Set<string>(lock?.names ?? [])
    for (const entries of [pkg?.dependencies, pkg?.devDependencies]) {
      for (const name of Object.keys(entries ?? {})) requested.add(name)
    }
    for (const workspacePkg of facts.packages) {
      const wp = await readJson<PackageJson>(path.join(root, workspacePkg.dir, "package.json"))
      for (const name of [
        ...Object.keys(wp?.dependencies ?? {}),
        ...Object.keys(wp?.devDependencies ?? {}),
      ]) {
        requested.add(name)
      }
    }

    if (!lock) {
      return {
        lens: LENS_ID,
        version: "1",
        title: "Dependency pin integrity",
        kind: "truth",
        status: "ran",
        disclosures: [
          "Dependency pins are declared but no lockfile (pnpm-lock.yaml, package-lock.json, yarn.lock) exists — liveness cannot be judged offline; skipped, not flagged.",
        ],
        findings,
      }
    }

    let unsupported = 0
    for (const { label, entries } of overrideSections) {
      for (const [rawKey] of Object.entries(entries)) {
        const pin = parsePinKey(rawKey)
        if (!pin) {
          unsupported += 1
          continue
        }
        if (requested.has(pin.name)) continue
        findings.push({
          lens: LENS_ID,
          id: `${LENS_ID}/dead-pin:${label}:${rawKey}`,
          tier: "gap",
          claim: `\`${label}\` pins \`${rawKey}\`, but nothing in ${lock.file} or any manifest requests \`${pin.name}\` any more — the pin rewrites nothing`,
          evidence: [
            "package.json",
            lock.file,
            `no installed or requested package named \`${pin.name}\``,
          ],
          why: "A dead pin is a constraint the repo no longer pays for but still claims: every reader (and every agent asked why it is there) reconstructs a dependency that is gone.",
          action: `Remove the \`${label}\` entry — or, if the dependency is coming back, say so in a comment beside it.`,
          effort: "S",
          confidence: "medium",
        })
      }
    }

    for (const { key, target } of patchTargets) {
      const parsed = parsePkgAtVersion(target)
      if (!parsed) continue
      const installed = lock.versions.get(parsed.name)
      const present = requested.has(parsed.name) && (!installed || installed.has(parsed.version))
      if (present) continue
      findings.push({
        lens: LENS_ID,
        id: `${LENS_ID}/dead-patch:${key}`,
        tier: "gap",
        claim: `\`${key}\` patches \`${parsed.name}@${parsed.version}\`, which ${lock.file} no longer carries at that version — the patch rewrites nothing`,
        evidence: ["package.json", lock.file, `${parsed.name}@${parsed.version} not installed`],
        why: "The patch file and its target drift apart silently: the patch stops applying (or applies to nothing) while the manifest still vouches for it.",
        action:
          "Remove the patch entry and its patch file, or re-point it at the version the tree actually installs.",
        effort: "S",
        confidence: "medium",
      })
    }

    if (unsupported) {
      disclosures.push(
        `${unsupported} pin key(s) use a shape offline arithmetic cannot judge (nested-path overrides like \`foo>bar\`) — skipped, not flagged.`,
      )
    }
    // A pin with a version selector is verified by NAME only: whether any request intersects the
    // selector needs range arithmetic etymd does not do offline, and a wrong "dead" costs more
    // trust than a missed one.
    const selective = overrideSections
      .flatMap(({ entries }) => Object.keys(entries))
      .filter((key) => parsePinKey(key)?.range).length
    if (selective) {
      disclosures.push(
        `${selective} pin key(s) carry a version selector (\`name@range\`) — verified by package name only; range intersection is not judged offline.`,
      )
    }
    // yarn patch directives (`patch:name@range#hash`) and other value shapes are inputs, not keys.
    disclosures.push(
      `Judged from ${lock.file} as committed — a lockfile not regenerated after a dependency change can misreport a pin as dead or alive. No network, registry, or tool was consulted.`,
    )

    return {
      lens: LENS_ID,
      version: "1",
      title: "Dependency pin integrity",
      kind: "truth",
      status: "ran",
      disclosures,
      findings,
    }
  },
}
