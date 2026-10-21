# The files Etymd keeps, and the config file

| Path                   | Lifecycle     | Role                                             |
| ---------------------- | ------------- | ------------------------------------------------ |
| `.etymd/baseline.json` | **committed** | the approved reckoning drift is measured against |
| `.etymd/ledger.json`   | **committed** | the findings memory: statuses, diffs, dismissals |
| `.etymd/config.json`   | **committed** | optional: audit scope + context budgets          |
| `.etymd/cache/`        | gitignored    | transient scan cache                             |

The committed files are written to be publishable: the baseline records `"."` as its scan root,
never your absolute machine path. Only the gitignored cache keeps the real one.

Formatter interop: if your Prettier (or similar formatter) checks JSON, add `.etymd` to
`.prettierignore`. Etymd writes its own JSON style, and a format gate fighting the ledger is
noise (this repo does exactly that).

## `.etymd/config.json` (optional)

Every key is optional; omit the file entirely and the defaults below apply.

```jsonc
{
  "instructions": {
    // Audit these too: files detection would not find on its own.
    "include": ["docs/handbook/**/*.md"],
    // Leave these out. The classic case: a fork that inherits upstream's skills
    // and will never fix them, but must keep its OWN instruction layer honest.
    "exclude": [".claude/skills/**"],
  },
  "context": {
    "perFileWords": 4000, // extraction candidate above this
    "totalWords": 8000, // always-loaded footprint budget
  },
  "gates": {
    // What `etymd gates` generates. Written for you on first run from what the scan
    // finds. Edit it here rather than editing the generated hook, so the next run
    // agrees with you instead of arguing.
    "commands": ["typecheck", "lint"], // pre-push steps, in order
    "failOn": "risk", // audit tier that fails the push: risk | gap | polish
    "publishGate": true, // screen the published artifact
    "commitFormat": true, // check the commit subject (Conventional Commits); off unless set
    "allowWriting": [], // commands allowed into a gate despite writing
    // Why a value here is what it is. Each key mirrors the field it explains. Etymd keeps
    // these, and drops one whose field it changes: a reason attached to a value it no
    // longer explains is worse than no reason at all.
    "_why": { "failOn": "no build and no tests here; only docs drift can fire" },
  },
}
```

Globs are repo-relative: `*` within a path segment, `**` across segments, `?` one character. A
pattern with no wildcard is a **path prefix**, so `.claude/skills` covers everything beneath it.

Narrowing an audit can hide findings, so Etymd never lets it happen quietly: **every excluded
file is counted and named in the lens disclosures**, and a config that fails to parse is reported
as a disclosure rather than silently falling back to defaults.
