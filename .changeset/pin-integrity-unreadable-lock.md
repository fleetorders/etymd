---
"etymd": patch
---

The pin-integrity lens no longer accuses pins when the lockfile cannot be parsed. A
`pnpm-lock.yaml` or `package-lock.json` that fails to parse used to index as empty, so every
override and patch looked dead; the lens now discloses the lockfile as unparsable and judges
nothing, as it does when no lockfile exists.
