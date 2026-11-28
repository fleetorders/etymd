---
"etymd": patch
---

Gate pack 38: four push-gate holes closed in the template.

- A push to an explicit URL or path on an existing branch bounds its
  checked range by the destination sha alone. The old rule subtracted
  every remote's tracking refs there, so a tip an unrelated remote
  happened to hold subtracted itself out of its own push — the exact
  pushed bytes skipped the shell checker.
- The checkout's `node_modules` is linked into the audit tree only where
  that tree has no `node_modules` entry of its own. With a committed one,
  `ln -s` wrote `node_modules/node_modules` inside it, and through a
  symlinked one the write followed it outside the audit tree. The lookup
  of the checkout root also runs scrubbed: an exported `GIT_WORK_TREE`
  answered for the wrong tree and the link silently never happened.
- A pushed ref that resolves to no commit — a tag pointing at a blob or
  a tree — is skipped with a disclosure line instead of refusing the
  push: the audit worktree cannot stand one up, and a valid tag is not a
  failed gate. The shell checker already tolerated these silently.
- The checker-version stamp moves only when commits were checked, so a
  deletes-only push cannot fake a re-baseline the next push then trusts.
