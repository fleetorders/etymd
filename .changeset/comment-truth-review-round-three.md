---
"etymd": patch
---

`comment-truth` judges whether a missing path belongs to this repo from where
the commenting file sits, not from every directory name anywhere in the tree.
A path in a comment is this repo's when its first directory exists at the root,
in a workspace package or their `src/` and `scripts/`, or in the commenting
file's own directory or one above it. The old repo-wide set took nearly every
quoted path as this repo's, because almost every repo has a `src`, `test` or
`docs` directory somewhere, and a directory deep in an unrelated package vouched
for a comment elsewhere.

`run script` and `run scripts` are read as a stand-in only where the repo has no
script of that literal name; a real `script` script is verified like any other,
in comments and in the task surface alike.

The disclosure for flag-adjacent paths now states the rule it applies: a path
written right after a command-line flag is skipped, whether it is the flag's
value or an operand after a boolean flag (`node --watch src/x.ts`). The 0.21.1
notes described only the first case.
