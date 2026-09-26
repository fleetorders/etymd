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
  # Trailing whitespace after the interpreter name is still the interpreter: a tab before a
  # flag (sh<TAB>-e) or a CRLF-committed first line (sh<CR>) must classify, or the script
  # leaves every bucket — unchecked, unexcluded, undisclosed.
  if grep -qE "^#!.*[/ ](ba|da)?sh([[:space:]].*)?$" "$work/first-line"; then
    printf "./%s\0" "$file" >> "$work/scripts" || exit 1
    printf . >> "$work/count" || exit 1
  else
    [ "$?" -eq 1 ] || exit 1
    if grep -qE "^#!.*[/ ]zsh([[:space:]].*)?$" "$work/first-line"; then
      printf . >> "$work/zsh-count" || exit 1
    else
      [ "$?" -eq 1 ] || exit 1
    fi
  fi
done
# etymd:generated pack-v16 bdb8a60087b268a2
