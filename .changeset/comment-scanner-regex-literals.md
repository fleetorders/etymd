---
"etymd": patch
---

The comment scanner no longer reads code as comment text in two common shapes.

In the JS family, a regex literal containing `/*` — `p.replace(/^\/*/, "")` is the
shape that fired — opened a block comment at the escaped slash and swallowed the code
after it, up to the next `*/`. Everything swallowed was read as one comment, so string
content inside it became path and command claims; a regex literal after an
expression-start token (`(`, `,`, `=`, a keyword like `return`) is now skipped whole,
escapes and character classes honored, and division after an expression is left as
division. Fixing this made the scanner see comments it had been blind to: a regex
literal's backticks previously desynced its string pairing and swallowed every comment
after it — in this repo, a sixty-line span of source documentation. Reading them is
correct; a few doc comments whose backticked examples are claim-shaped were reworded
so the tool does not flag its own grammar explanations as dead commands.

In shell (and YAML, ini, Dockerfile), `#` now opens a comment only at the start of a
word: `${f#src/…}` is parameter expansion, not a comment, and reading it as one turned
pattern text into path findings. Languages where `#` comments start anywhere (Python,
Ruby, Perl, GraphQL, TOML, make) keep the old rule.

Separately, an empty `git ls-files` answer is no longer read as a git failure: zero
tracked files is "checked nothing", not "could not run" — a freshly materialised tree
can honestly have none.
