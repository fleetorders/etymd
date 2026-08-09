# 007 — Declared entry fields: the file names them, the tool only checks presence

Scope: etymd — the decisions-format marker and the `state-freshness` per-entry field checks.

_Status: implemented. A narrow first instance of the derived/declared split
[005](005-declared-rules.md) designs: the smallest surface on which a user can assert a check of
their own, delivered without the declared-rules machinery and without a predicate vocabulary._

## The need, and the shape it arrived in

A repository wanted its decision entries to carry fields beyond the two etymd already knows about
(`Scope:`, `Revisit:`) — a project can reasonably require an owner, a rollback note, a consequences
section, whichever fields its record is supposed to answer. Nothing in the tool could express that,
and the obvious response was to add the fields.

That response was rejected, twice over, and the rejections are the substance of this record.

## Rejected — shipping the field names

Adding named fields to `checkFormatFields` mechanizes cleanly, which is exactly why it is a trap:
AGENTS.md's second test asks **would a user who is not us ever set this?** A field vocabulary
coined by one project fails that test no matter how well it is implemented, and
[005](005-declared-rules.md) already carries the standing non-goal — _no preset carrying our
vocabulary; shapes generalize, framings do not._

So the tool ships the **shape** — a file may require fields — and holds no opinion about which
names are worth requiring. Etymd never interprets a declared name; it checks that a line
introducing it exists. A name it cannot use is disclosed, never silently dropped, because a file
that believes it declared a field and is quietly audited without it would read as clean for the
one reason this tool exists to reject.

## Rejected — a keyword trigger for which entries must comply

The second proposal was to require the fields only on entries whose prose looks like it is claiming
something (containing "closed", "fixed", "gated"). That is a recall-driven trigger in a repo whose
rule is **precision over recall**: an entry mentioning a closed tab or a fixed price would be told
its record is malformed, and a false "your file is lying" costs more trust than a missed one.

Every-entry enforcement needs no heuristic, is explainable in one sentence, and cannot be dodged by
how a sentence happens to read. It is also what `Scope:` already does, so the two behave alike.

## Corrected — "every entry" means every entry from the marker's position

The first implementation read "every entry" as every entry in the file, while the finding text it
emitted said _after the marker_ and this record promised forward-only. The gap shows up the first
time a long-lived ledger declares fields mid-life: the audit demands them from entries written long
before the declaration existed, which no append-only record can supply without rewriting history.

Forward-only is therefore a claim about **position**, not merely about the file: presence checks —
the declared fields and the built-in `Scope:` sharing the same loop — bind entries whose heading
starts at or after the marker. A marker left at the top of a file governs all of it, which is what
a file that declared the format from the start means; a marker appended lower exempts the history
above it. Exempt entries are counted and named in the disclosures, because an entry nobody checked
is unchecked, not clean.

`Revisit:` keeps whole-file reach. It is not a presence requirement — it fires only where the entry
already wrote a date down, and a promise the entry made itself falls due wherever it sits.

## The marker carries the declaration, not the config file

`<!-- decisions-format: 1 fields=Owner,Rollback -->`

The marker was already the opt-in gate, so putting the declaration there adds no second surface to
consult and keeps the requirement beside the entries it governs — a reader of the file learns the
rule from the file. It also gives per-artifact granularity for free, which a single `state` config
section could not: a repo may keep two decision records with different obligations.

`fields=` is an **extension, not a new format version**. A marker without it behaves exactly as
before, so no existing file changes meaning. A version this build does not know is honoured as
version 1 and disclosed rather than guessed at or silently skipped.

Declared names are restricted to letters, digits, spaces, `-` and `_`, which keeps regex
metacharacters out of the matcher by construction rather than by escaping discipline. A redeclared
`Scope` is dropped, since two findings for one missing line would be noise.

## What this does not become

This is a presence check on a record etymd already parses — not the declared-rules predicate
vocabulary, and not a step toward one. [005](005-declared-rules.md)'s fitness test and its count
alarm still govern anything that would generalize this into a predicate users can point at
arbitrary files. If that case arrives, it arrives through 005, with the five questions answered in
writing.
