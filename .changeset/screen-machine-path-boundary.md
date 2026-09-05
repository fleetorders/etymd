---
"etymd": patch
---

The content screen's machine-path rule now fires only at a path boundary (line start,
whitespace, a quote, `=`, `(`, `[` or `:`). A home path inside a longer token or a URL —
a test fixture's `$ROOT/home/x/` temp root, a docs URL with a `/home/` segment — is not a
machine path, and no longer prints the same advisory line on every push. A bare
`/Users/<name>/…` or `/home/<name>/…` still hits.
