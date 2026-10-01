# Known limitations

Accepted trade-offs, not bugs. Precision over recall throughout: a false "your file is lying"
costs more trust than a missed lie, and every skip class is disclosed in the lens report.

- **Extensionless file references go unchecked.** `lib/barcode-scan` (no extension, no trailing
  slash) is treated as prose. A directory claim needs a trailing `/`; a file claim needs a
  _recognized_ extension (`KNOWN_EXTENSIONS` in `src/lenses/instruction-truth/claims.ts`; an
  unknown suffix like `.after` is prose). A real file with an exotic extension goes unchecked as
  the accepted cost.
- **Create-this path claims are never accused.** When every mention of a path sits in prose that
  instructs creating, generating or writing it, the repo is right to lack it. The cost: a
  genuinely stale path mentioned _only_ inside creation prose goes unchecked. One plain reference
  anywhere in the file restores the check.
- **Naming stand-ins are not claims.** A segment prefixed `my-` or `your-`, or named
  `placeholder`, `foo`, `bar`, `baz` or `qux`, is a shape description. A real directory called
  `my-thing` therefore goes unchecked.
- **Developer-machine facts are not judged from CI.** Git hook wiring (`core.hooksPath`) is absent
  from an ephemeral CI checkout by design, so in CI it is skipped and disclosed rather than
  flagged. Without this, the `audit --fail-on risk` gate this tool recommends would fail forever
  in every repo with tracked hooks. The cost: a genuinely unwired hook set is only reported
  locally.
- **Gitignored path claims are never accused.** A claimed path that is missing but matched by
  `.gitignore` (`.env` files, local caches) is machine-local by design: skipped and disclosed,
  since its absence in one checkout does not make the instruction false anywhere else.
- **Package-relative paths** resolve only against workspace roots plus their `src/` and
  `scripts/` sub-roots. Deeper prose-relative prefixes (relative to `apps/x/src/lib/`, say) are
  not chased.
- **Workspace-filtered commands** (`pnpm --filter x test`) are skipped, counted and disclosed,
  not resolved into the target package.
- **Server-side quality thresholds** (Sonar and the like) cannot be read from the repo; findings
  say exactly that.
- **A script a pushed commit did not touch is not re-checked.** The pre-push shellcheck step reads
  only what each commit changes; an untouched script carries bytes a previous push already
  checked. The commit that installs or changes the gate, its classifier, or a `.shellcheckrc` is
  checked whole, so a repo's existing scripts are read once at adoption. The cost: a commit
  pushed with `--no-verify` is never re-read by a later push; a periodic whole-tree `shellcheck`
  run closes that gap.
- **A hook generated before the generation stamp existed cannot be proven untouched.** It has no
  stamp, so `etymd gates` keeps it rather than regenerating, stating the reason and the way out.
  One regeneration makes it provable from then on. The asymmetry is deliberate (D-006 in the
  [design record](https://github.com/fleetorders/etymd/blob/main/docs/decisions.md)): a stamp
  can prove a file is safe to replace, never that it is unsafe.
- **A companion (`<hook>.local`) without the execute bit is not counted as enforcement.** The
  generated hook guards the call with `[ -x ]`, so such a file never runs; the lens mirrors that
  and reports it as inert rather than crediting checks that do not fire. Where the execute bit is
  not a meaningful question (no POSIX mode bits), the checks are counted rather than a dead gate
  invented.
