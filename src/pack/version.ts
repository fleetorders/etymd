/**
 * The version of the generated files, bumped whenever a template changes meaning. Stamped into
 * facts, baselines and generated artifacts so drift against the templates is computable.
 *
 * Gaps in the sequence are deliberate: a number stays retired even when the change that took it
 * never shipped, so a version cited in a baseline or a record means exactly one pack, ever.
 * 19 through 28 were taken by a parallel line of pack changes; they stay retired here too —
 * one number, one pack, whichever line wrote it.
 */
export const PACK_VERSION = "29"
