---
"etymd": patch
---

Generated pre-push hooks read each pushed commit's scripts as raw blobs from git instead of checking the commit out. A checkout applied `.gitattributes` line-ending conversion, so under `eol=crlf` a script's shebang line ended in a carriage return and the script left the checked set without a message. The hook also no longer writes a commit's whole tree: one `git grep` pass finds the changed files with a `#!` line, and only those are read, which makes a whole-tree check faster than before. Symlink entries are now a disclosed skip, since a link's target is checked under its own path. The classifier refuses the old call shape, so a hand-edited pre-push kept across a regeneration stops the push and says to run `etymd gates`. Regenerate existing hooks with `etymd gates --yes`.
