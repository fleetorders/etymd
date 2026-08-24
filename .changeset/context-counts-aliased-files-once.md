---
"etymd": patch
---

Context economy counts a file once when two instruction names are the same file.

`AGENTS.md` symlinked to `CLAUDE.md` is the ordinary way to serve harnesses that read different
names. Both names were measured separately, which doubled the reported always-loaded footprint —
enough to manufacture an over-budget finding out of nothing — and fired the heavy-file finding
twice for one file. Candidates resolving to the same inode (symlink or hardlink) are now counted
once and reported under every name they answer to, in `etymd audit` and `etymd context` alike,
with the merge stated in the lens disclosures.
