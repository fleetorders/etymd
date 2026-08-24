/**
 * The knowledge-pack version — bumped whenever templates, the rubric, or the encoded rules
 * change meaning. Stamped into facts, baselines, and generated artifacts so drift against the
 * pack is computable and `harvest` has something to diff.
 *
 * Gaps in the sequence are deliberate: a number stays retired even when the change that took it
 * never shipped, so a version cited in a baseline or a record means exactly one pack, ever.
 */
export const PACK_VERSION = "12"
