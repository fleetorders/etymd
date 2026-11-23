---
"etymd": patch
---

`comment-truth` reads a comment from where its file sits, and stops accusing references it
cannot judge. A path in a comment now also resolves from every directory above the commenting
file, so a nested package that no workspace declares (`tools/site/src/build.mjs` saying
`src/build.mjs`) is read the way its author wrote it, and a JavaScript import specifier
resolves to its TypeScript source (`./logs.js` beside `logs.ts`). Scripts of every tracked
`package.json` count, not only declared workspaces. Five classes are now skipped, each counted
and named in the report: a missing path that starts at no directory name the repo carries
(quoted from another tree); slash-joined file names (`a.ts/b.ts`, alternatives rather than a
path, on every surface); a path that appears only as the value of a command-line flag in a
usage line; a bare `CLAUDE.md` or `AGENTS.md` mention that may mean the reader's user-level
file; and package-manager commands in a repo with no manifest at all. `pnpm run` named for
itself, and `run script` with the word standing in for a name, are no longer read as script
claims. Instruction files keep their stricter reading throughout.
