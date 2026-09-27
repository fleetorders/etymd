# 013 — The shell gate stays generated shell, and a change to it is replayed against real history

Scope: etymd — the pre-push shellcheck step that `etymd gates` generates, and how a change to it
is released.

_Status: implemented._

## Why

The shellcheck step began as one call and grew, one fix at a time, into a few hundred lines of
generated shell: it enumerates the pushed commits, reads each one from git, classifies scripts
by shebang, and runs the checker. Each fix to that logic ships as a new pack, and every repo
that uses the gate has to regenerate its hooks to receive it. That cost raised the question of
moving the logic into the CLI and leaving the hook a one-line call, so a fix would reach every
repo through an ordinary package update. No earlier record answered it; the step was never
designed as a whole, only extended.

The same week showed the other half of the problem. A change to how the step reads a commit —
raw blobs instead of a checkout, to stop line-ending conversion hiding scripts — also dropped
what the checkout had provided without anyone listing it: the repo's `.shellcheckrc`, and the
files scripts source. The unit tests pinned the case being fixed and passed; nothing named the
cases nobody thought of, and the regression shipped.

## Decision

1. **The logic stays in the generated hook.** Three properties decide it, all of which the CLI
   form would lose:
   - **The hook pins the behaviour.** The repos this step exists for are often shell-only, with
     no `package.json` to pin a tool version in. A hook that called the CLI would run whatever
     version each machine has installed, so the same commit could pass on one machine and fail
     on another. The generated file is the version, and it is readable in the repo.
   - **Anyone who clones the repo keeps the gate.** The hook needs git, a POSIX shell and
     shellcheck. It does not need etymd, which is the repo owner's choice rather than a
     contributor's dependency. Moved into the CLI, the gate would become a disclosed skip for
     every contributor without it — the "looks installed everywhere, runs nowhere" failure the
     step is written to prevent.
   - **A push never needs the network.** `npx` would fetch the tool at push time.
2. **A change to the step is replayed before it is released.** `scripts/hook-diff.mjs` runs the
   shellcheck section of two hook versions over the recent first-parent commits of real repos
   and reports every difference in what each read, what it found, and whether it passed. Every
   difference is explained before a pack that changes the step is published. It is read-only
   and runs only the shellcheck section, never a repo's other gates.

## Rejected

- **A one-line hook calling the CLI** — for the three reasons above. The regeneration cost is
  the price of those guarantees; the remedy is to stop shipping fixes that need fixing again.
- **More unit tests as the only guard.** They pin known cases. The regression that prompted
  this record was an unknown one, and only a replay of real history compares everything the old
  read did against everything the new one does.

## Verify

- Take a repo whose `.shellcheckrc` disables a finding one of its scripts has. Run
  `node scripts/hook-diff.mjs --old <pack-16 dir> --new <pack-17 dir> <repo>`: it exits 1 and
  names the finding as new — the regression this record describes, caught.
- The same run with the pack-18 hooks as `--new` exits 0.
