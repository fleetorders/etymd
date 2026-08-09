---
"etymd": minor
---

Decisions records can require fields of their own, and etymd holds no opinion about which.

A decisions file already opts into per-entry format checks with a marker. It can now append field
names to it — `<!-- decisions-format: 1 fields=Owner,Rollback -->` — and every entry after the
marker must carry each one. `Owner:` and `**Owner:**` both count. Decision record:
[`docs/decisions/007-declared-entry-fields.md`](docs/decisions/007-declared-entry-fields.md).

**The tool ships the shape, not the vocabulary.** Etymd never interprets a declared name and has no
list of fields it thinks a record ought to have; it verifies that a line introducing the name
exists, and that is all. Which fields are worth requiring is the file's position to take, not the
tool's — a name coined for one project's process is exactly the kind of opinion this package does
not ship, however cleanly it would mechanize.

**Nothing is dropped in silence.** A name that cannot be used as a field, a marker version this
build does not know, and a redeclared `Scope` are each disclosed in the lens report. A file that
believes it declared a requirement, and is quietly audited without it, would come back clean for
the one reason this tool exists to reject — so the failure is stated rather than absorbed.
Declarable names are letters, digits, spaces, `-` and `_`, which keeps regex metacharacters out of
the matcher by construction.

**Enforcement is every-entry, with no keyword trigger.** Requiring the fields only on entries whose
prose looks like it is claiming something would flag an entry that mentions a closed tab or a fixed
price, and a false "your file is lying" costs more trust than a missed one. Every entry after the
marker is held to the same rule, which is what `Scope:` already does and takes one sentence to
explain.

**Existing files are unaffected.** `fields=` is an extension rather than a new format version: a
marker without it behaves exactly as before, pre-marker entries stay untouched, and a repo that
declares nothing sees no change. The declaration lives on the marker rather than in
`.etymd/config.json` so the requirement sits beside the entries it governs, which also lets a repo
keep two decision records with different obligations.
