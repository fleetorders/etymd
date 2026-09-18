## "etymd": patch

Generated pre-push hooks no longer refuse a push over a tracked path the git archive does not
carry (an `export-ignore`d file, a submodule gitlink, a dangling symlink): such paths are
counted and disclosed as unread instead of hard-failing discovery, while a path that is
present but unreadable still refuses the push. Commits that share a tree are materialised and
shellchecked once per distinct tree rather than once per commit, so merge/squash histories no
longer pay a full-tree extraction and checker run per commit. Enumeration and discovery
failures now carry the same `✗ shellcheck:` prefix as every other failure in that step, so a
night refusal names the checker, not the pack generator. Regenerate existing hooks with
`etymd gates --yes` to apply the correction.
