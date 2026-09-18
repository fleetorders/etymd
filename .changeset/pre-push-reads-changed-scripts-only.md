---
"etymd": patch
---

Generated pre-push hooks shellcheck only the shell scripts the PUSHED COMMITS changed — each
read at the commit that changed it — instead of every script in every distinct tree of the
push, and the style-advice pass runs once per script at its last-changing commit instead of
once per commit over the whole tree. A push of many small commits now pays for its changes,
not for its commit count. Merges are read through their combined diff (the resolution, not
the merged branches' files), a commit with no readable first parent still reads its whole
tree, export-ignored scripts are now reachable and checked, and a commit that changes no
shell script says so in one line. Regenerate existing hooks with `etymd gates --yes`.
