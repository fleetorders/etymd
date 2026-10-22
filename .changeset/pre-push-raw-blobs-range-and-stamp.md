---
"etymd": patch
---

Three pre-push gate defects fixed (pack 26).

The audit worktree is now populated entry by entry from git's object store
(`git cat-file blob`) instead of `git archive | tar`. `git archive` runs working-tree
conversion: a repo with a required checkout filter killed the archive mid-stream, the
pipeline read tar's status instead, and the audit then ran over an EMPTY tree — certifying
bytes the gate never read (on GNU tar the same death refused every push). A non-required
filter was worse: the audit silently read CONVERTED bytes. Raw blobs run no filter at all;
symlinks are re-linked, the exec bit is kept, a tip whose entries cannot be written refuses
the push.

The existing-branch push range now subtracts remote-tracking refs (`rev-list <local> --not
<remote-sha> --remotes…`) like the new-branch case always did. A branch that merged the
upstream dragged every upstream commit into its push range, and each was re-checked at its
own tree — where later fixes do not exist — so a branch whose tip was clean was refused over
warnings a later commit had already fixed.

The checker-version stamp is written only after the checks pass. It was written before, so
a push the upgraded checker refused still consumed the whole-surface re-baseline; the retry
then read only touched paths and the re-baseline never completed.

Pack 25 is retired-unused on this line (a parallel branch stamped it; a number means one
pack, ever). Regenerate existing hooks with `etymd gates --yes`.
