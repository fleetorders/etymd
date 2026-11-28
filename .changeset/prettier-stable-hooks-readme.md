---
"etymd": patch
---

The generated `.githooks/README.md` is now emitted in the shape markdown
formatters leave alone (pack 30).

Prettier's markdown formatter separates a trailing block-level HTML comment
from the paragraph above it, so a consumer repo running `prettier --check .`
over a freshly installed gate pack failed on the README the moment it was
written — regeneration itself turned the consumer's format gate red. The
escape a consumer naturally reaches for is worse than the failure: letting
the formatter fix the file changes its bytes, the `etymd:generated` stamp no
longer matches its digest, and the README is reclassified as hand-edited —
kept forever, never refreshed again, the exact silent drift the stamp exists
to prevent. The freeze is not hypothetical: a single format pass over an
installed pack makes the edit, and the file stops regenerating from that
day on.

The template now carries the blank line before its stamp and keeps the final
newline, so the file passes `prettier --check` byte-for-byte as generated,
under the formatter generations that demand the blank line and the ones that
do not. Existing installs regenerate normally: the old README classifies as
stale, not edited. Repos that worked around this by ignoring `.githooks/` in
their formatter config can drop the ignore after upgrading.
