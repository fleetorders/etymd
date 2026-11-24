#!/usr/bin/env sh
# etymd: shell script discovery for the pre-push shellcheck step. Four calls per commit:
#   discover-shell-scripts.sh --config <scratch> <tree> <ls-tree record>...
#   discover-shell-scripts.sh --skips <scratch> <ls-tree record>...
#   discover-shell-scripts.sh --commit <scratch> <tree> <commit> <commit>:<path>...
#   discover-shell-scripts.sh --context <scratch> <tree> <ls-tree record>...
# --config writes the commit's .shellcheckrc files into the tree as raw blobs, so the checker
# finds its config where it looks, and flags one that turns external-sources on. --skips counts
# the changed paths that are symlinks or submodule entries. --commit reads the candidates
# `git grep` found with a line starting `#!`, and classifies each by its FIRST line. Verdicts
# land in the scratch: scripts (NUL-delimited matches) and one dot per decision into count /
# zsh-count / other-count / skip-count, tallied by the hook after the pipeline. Each script found is written
# into <tree> at its path, so the checker reads it there. With external-sources on, --context
# then stages, as raw blobs, the files the staged scripts source.
#
# Every byte comes from git's object store as the raw blob — `git cat-file blob`, which
# applies no eol, text or filter attribute. A checkout converts: under `eol=crlf` the shebang
# line ends in a carriage return, the match below fails, and the script leaves the checked set
# without a word. Only the entries handed in are read, never the whole commit.
#
# A symlink or submodule entry has no script bytes of its own — a link's target is a tracked
# path checked under its own name — so it is a disclosed skip, never a block. A candidate that
# cannot be read fails, naming the path: coverage would otherwise silently shrink.
#
# The match/error protocol: grep reports "no match" as 1 and a failure as 2 or more, and only
# the first is a verdict. Letting a failure fall through would pass a broken matcher as "not a
# shell script" — the exact silent coverage-shrink the fail-closed rules exist to prevent. The
# status is captured on the grep's own line (`|| st=$?`), so no command added later can come
# between the grep and the check and silently replace the status being read.
tab=$(printf '\t')
case ${1-} in
  (--skips)
    # Records only: a symlink or submodule entry is counted, everything else is left to the
    # candidate pass. Builtins only — this loop sees every changed path.
    work=$2
    shift 2
    for record do
      case ${record%% *} in
        (100644|100755) ;;
        (*) printf . >> "$work/skip-count" || exit 1 ;;
      esac
    done
    exit 0 ;;
  (--config)
    # Every entry of the commit, of which only .shellcheckrc files are kept — builtins decide,
    # so the whole listing costs no process per path. Each is written into the tree as its raw
    # blob, where the checker looks for it, and one turning external-sources on is flagged.
    work=$2
    tree=$3
    shift 3
    for record do
      meta=${record%%"$tab"*}
      file=${record#*"$tab"}
      # A record path must stay inside the tree before anything consumes it: git's own
      # writers refuse a tree entry whose name carries .., but a hand-forged or corrupted
      # object reaches ls-tree verbatim, and an escaping name writes outside the tree.
      case $file in
        (""|/*|.|..|./*|../*|*/..|*/../*|*/.|*/./*)
          echo "etymd: tracked path does not stay inside the checked tree: $file" >&2
          exit 1 ;;
      esac
      case $file in
        (.shellcheckrc|*/.shellcheckrc) ;;
        (*) continue ;;
      esac
      case ${meta%% *} in
        (100644|100755) ;;
        (*) continue ;;
      esac
      case $file in
        (*/*) dir=${file%/*} ;;
        (*) dir=. ;;
      esac
      mkdir -p -- "$tree/$dir" && git cat-file blob "${meta##* }" > "$tree/$file" || {
        echo "etymd: cannot read tracked file for shellcheck: $file" >&2
        exit 1
      }
      st=0
      grep -qE '^[[:space:]]*external-sources[[:space:]]*=[[:space:]]*true' "$tree/$file" || st=$?
      case $st in
        (0) : > "$work/external-sources" || exit 1 ;;
        (1) ;;
        (*) exit 1 ;;
      esac
    done
    exit 0 ;;
  (--context)
    # Records again, for external sources: a regular entry whose file name is among the names
    # the staged files source (scratch/source-names, one per line) is written into the tree as
    # its raw blob, unless the tree has it already. Matching by name over-stages at worst, and
    # a raw blob runs no checkout filter — an unrelated file's filter can never refuse the push.
    work=$2
    tree=$3
    shift 3
    nl='
'
    names="$nl$(cat "$work/source-names")$nl" || exit 1
    for record do
      meta=${record%%"$tab"*}
      file=${record#*"$tab"}
      # The same staying-inside guard as --config: the path is consumed below (mkdir, the
      # blob write) before any later filter can be trusted to neutralise it.
      case $file in
        (""|/*|.|..|./*|../*|*/..|*/../*|*/.|*/./*)
          echo "etymd: tracked path does not stay inside the checked tree: $file" >&2
          exit 1 ;;
      esac
      case ${meta%% *} in
        (100644|100755) ;;
        (*) continue ;;
      esac
      case $names in
        (*"$nl${file##*/}$nl"*) ;;
        (*) continue ;;
      esac
      [ -e "$tree/$file" ] && continue
      case $file in
        (*/*) dir=${file%/*} ;;
        (*) dir=. ;;
      esac
      mkdir -p -- "$tree/$dir" && git cat-file blob "${meta##* }" > "$tree/$file" || {
        echo "etymd: cannot read tracked file for shellcheck: $file" >&2
        exit 1
      }
    done
    exit 0 ;;
  (--commit)
    [ $# -ge 4 ] || exit 1 ;;
  (*)
    echo "etymd: discover-shell-scripts.sh expects --commit, --skips, --config or --context; the pre-push beside it is older than this classifier — run 'etymd gates'" >&2
    exit 1 ;;
esac
work=$2
tree=$3
sha=$4
shift 4
for entry do
  file=${entry#"$sha":}
  # The path is consumed below (the blob read, the mv into the tree): the same
  # staying-inside guard as the other arms, checked before any byte moves.
  case $file in
    (""|/*|.|..|./*|../*|*/..|*/../*|*/.|*/./*)
      echo "etymd: tracked path does not stay inside the checked tree: $file" >&2
      exit 1 ;;
  esac
  # 4096 bytes bound the classifying read — a binary with no newline would otherwise be copied
  # whole into the next step. The second head restores line-1-only semantics, so a shebang
  # embedded on a LATER line of a document cannot match the patterns below.
  git cat-file blob "$sha:$file" > "$work/blob" && head -c 4096 "$work/blob" > "$work/head-bytes" || {
    echo "etymd: cannot read tracked file for shellcheck: $file" >&2
    exit 1
  }
  head -n 1 "$work/head-bytes" > "$work/first-line" || exit 1
  # The interpreter is read ONCE, as a name: the first word after #! with its directory
  # stripped, or — where that word is env — the first word after env's own options and NAME=value
  # settings (env -S bash -e is bash), or — where it is busybox — the applet it runs. One name,
  # one case below, so a versioned or suffixed build (bash5, zsh-5.9) lands in its family
  # instead of slipping past three near-duplicate patterns. Spaces, tabs and a trailing carriage
  # return all separate words: a tab before a flag (sh<TAB>-e) or a first line committed with
  # CRLF must still classify, or the script leaves every bucket — unchecked, unexcluded,
  # undisclosed. LC_ALL=C: the line is bytes, possibly not text in the caller's locale. A first
  # line with no shebang prints nothing.
  interp=$(LC_ALL=C awk 'NR == 1 {
      if (substr($0, 1, 2) != "#!") exit
      line = substr($0, 3)
      gsub(/[\t\r]/, " ", line)
      n = split(line, w, " ")
      i = 1
      name = w[1]
      sub(/.*\//, "", name)
      if (name == "env") {
        for (i = 2; i <= n; i++) {
          if (w[i] == "-u" || w[i] == "--unset" || w[i] == "-C" || w[i] == "--chdir" || w[i] == "-P") { i++; continue }
          if (w[i] ~ /^-/ || w[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) continue
          break
        }
        name = (i <= n) ? w[i] : ""
        sub(/.*\//, "", name)
      }
      if (name == "busybox") name = (i + 1 <= n) ? w[i + 1] : ""
      print name
      exit
    }' "$work/first-line") || exit 1
  case $interp in
    (sh|bash|dash|sh[0-9]*|bash[0-9]*|dash[0-9]*|sh-[0-9]*|bash-[0-9]*|dash-[0-9]*)
      case $file in
        (*/*) dir=${file%/*} ;;
        (*) dir=. ;;
      esac
      mkdir -p -- "$tree/$dir" && mv -- "$work/blob" "$tree/$file" || {
        echo "etymd: cannot stage tracked file for shellcheck: $file" >&2
        exit 1
      }
      printf "./%s\0" "$file" >> "$work/scripts" || exit 1
      printf . >> "$work/count" || exit 1 ;;
    (zsh|zsh[0-9]*|zsh-[0-9]*)
      printf . >> "$work/zsh-count" || exit 1 ;;
    (ksh|ksh[0-9]*|ksh-[0-9]*|mksh|pdksh|oksh|lksh|ash|yash|posh|csh|tcsh|fish)
      # Another shell is a script this gate cannot check; it gets its own bucket, announced by
      # the hook like the zsh exclusion — a coverage hole that is silent is indistinguishable
      # from coverage.
      printf . >> "$work/other-count" || exit 1 ;;
    (*)
      # No shebang (data), or an interpreter that is not a shell at all (node, python3, ruby,
      # perl, deno …): not a shell script, so no bucket and no announcement — counting every
      # Node or Python tool as a shell coverage hole printed a standing line pushers learned to
      # ignore, the opposite of what an announced hole is for.
      ;;
  esac
done
# etymd:generated pack-v32 ef84aee1e2ec0c6f
