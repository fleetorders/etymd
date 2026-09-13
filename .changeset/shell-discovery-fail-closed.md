---
"etymd": patch
---

Generated pre-push hooks preserve long filenames, whitespace, quotes, and leading hyphens
during shell-script discovery and checking. Failed enumeration or shebang reads now block the
hook instead of reporting success with incomplete coverage. Regenerate existing hooks with
`etymd gates --yes` to apply the correction.
