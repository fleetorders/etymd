---
"etymd": patch
---

Generated pre-push hooks honour a repo's `.shellcheckrc` again. Since 0.19.3 only scripts were read into the check's scratch tree, so the checker never found the config beside them and its settings were silently ignored. Every `.shellcheckrc` in the pushed commit is now read in as its raw blob. When one turns `external-sources` on, the files the scripts source (a `.` or `source` argument, or a `source=` directive, followed through nested helpers) are read in as raw blobs too, so a helper without a shebang is there to follow. Nothing is checked out, so an unrelated file's checkout filter can never refuse the push. Regenerate existing hooks with `etymd gates --yes`.
