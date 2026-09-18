"etymd": patch
---

The gate inventory now reads checks run through a wrapper function — a shell function that
forwards its positional parameters to the package manager (`run() { pnpm "$1"; }; run lint`),
an ordinary way to write a hook. Calls whose script name is a variable are counted and lower
the ci-only finding's confidence instead of asserting a gap this tool cannot see through.
The package-manager invocation scan also no longer leaks across newlines: a `pnpm "$1"` whose
arguments follow on later lines can no longer swallow unrelated tokens and hide a real gap.
