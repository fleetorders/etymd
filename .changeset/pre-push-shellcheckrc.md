---
"etymd": patch
---

Generated pre-push hooks honour a repo's `.shellcheckrc` again. Since 0.19.3 only scripts were read into the check's scratch tree, so the checker never found the config beside them and its settings were silently ignored. Every `.shellcheckrc` in the pushed commit is now read in as its raw blob. When one turns `external-sources` on, the rest of the commit is checked out as context, so a sourced helper without a shebang is there to follow; the scripts themselves are still read as raw blobs over it. Regenerate existing hooks with `etymd gates --yes`.
