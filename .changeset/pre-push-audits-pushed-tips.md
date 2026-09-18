---
"etymd": patch
---

Generated pre-push hooks run `etymd audit` at the TIP OF EACH PUSHED REF, materialised as a
detached worktree of that commit, instead of auditing the checkout the push happens to run
from — which was wrong in both directions: a clean branch was refused for a gap living only
in the pushing checkout's working tree, and a branch carrying a gap shipped because that
checkout happened to be clean. The audit runs scrubbed of git's exported names so it stands
in the materialised worktree, a push carrying no commits (deletes only) audits nothing and
says so, and a tip that cannot be materialised refuses the push rather than certifying bytes
the gate did not read. Regenerate existing hooks with `etymd gates --yes`.
