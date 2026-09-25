#!/usr/bin/env sh
# etymd: shell script discovery for the pre-push shellcheck step. Arguments: the scratch
# directory the hook created, then the tracked paths to classify (NUL-delimited on the hook's
# side, positional here). Verdicts land in the scratch: scripts (NUL-delimited matches) and one
# dot per decision into count / zsh-count / skip-count, tallied by the hook after the pipeline.
#
# The hook runs it from inside a commit materialised from git's object store, so paths resolve
# against that tree, never the working tree. A path with nothing readable behind it — a
# submodule entry, a dangling symlink — cannot lie about its contents, so it is a disclosed
# skip, never a block. A regular file
# that EXISTS but cannot be read is the other branch — coverage would silently shrink, so it
# fails, naming the path.
#
# The two `[ "$?" -eq 1 ]` guards are the match/error protocol: grep reports "no match" as 1
# and a failure as 2 or more, and only the first is a verdict. Dropping the guard would let a
# failing matcher pass as "not a shell script" — the exact silent coverage-shrink the
# fail-closed rules exist to prevent. The checker does not associate `$?` with the enclosing
# if-condition, which is why this shape survives the pass it serves; keep it that way.
#
# The scratch names (head-bytes, first-line) are FIXED and shared across invocations: xargs
# starts one process per batch, sequentially, and each batch overwrites the same two files on
# its way to appending its verdicts. That is safe ONLY while the batches never overlap — the
# load-bearing invariant. Never add -P to the xargs that drives this, and never run a second
# consumer of the same scratch directory: concurrent batches would interleave head reads with
# another file's verdicts, and the tally protocol below would count scripts it never read.
work=$1
shift
for file do
  if [ ! -f "./$file" ]; then
    printf . >> "$work/skip-count" || exit 1
    continue
  fi
  # 4096 bytes bound the read — a binary with no newline would otherwise be copied whole
  # into the scratch on every push. The second head restores line-1-only semantics, so a
  # shebang embedded on a LATER line of a document cannot match the patterns below.
  head -c 4096 "./$file" > "$work/head-bytes" || {
    echo "etymd: cannot read tracked file for shellcheck: $file" >&2
    exit 1
  }
  head -n 1 "$work/head-bytes" > "$work/first-line" || exit 1
  if grep -qE "^#!.*[/ ](ba|da)?sh( |$)" "$work/first-line"; then
    printf "./%s\0" "$file" >> "$work/scripts" || exit 1
    printf . >> "$work/count" || exit 1
  else
    [ "$?" -eq 1 ] || exit 1
    if grep -qE "^#!.*[/ ]zsh( |$)" "$work/first-line"; then
      printf . >> "$work/zsh-count" || exit 1
    else
      [ "$?" -eq 1 ] || exit 1
    fi
  fi
done
# etymd:generated pack-v17 b5bf2afe936ba644
