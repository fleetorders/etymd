---
"etymd": patch
---

Generated pre-push reads its discovery tallies through arithmetic before the integer tests
consume them. POSIX permits `wc` to pad its counts with leading blanks, and a `[`
implementation may reject a padded integer — which would turn all three gate branches false
and silently skip the shellcheck step, the exact silent coverage shrink the pack's comments
promise cannot happen. No mainstream shell was shown to fail (bash, dash and busybox all
parse padded integers), so this is portability hardening that also makes the hook consistent
with its own stripped `wc -l` read. Regenerate existing hooks with `etymd gates --yes` to
apply.
