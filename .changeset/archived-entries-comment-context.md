---
"etymd": minor
---

Fleet manifests take an `archived` field (`true` or a date) on an entry. `etymd fleet`,
`fleet check` and `propose` skip an archived entry and say how many they skipped; its name stays
taken, so `fleet add` and `--only` refuse it.

The comment lens reads what a comment says about a missing path before flagging it. A path
introduced as an example, placed inside a built artifact, written after a sibling repository's
name, found under a nested package's directory, or cut by a line wrap inside a parenthesis is
counted and disclosed, not flagged. `etymd audit --upstream <remote>` (and a fleet entry's
`upstream` field) also leaves alone a comment last written by a commit of the fork's upstream
remote.
