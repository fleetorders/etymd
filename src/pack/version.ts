/**
 * The knowledge-pack version — bumped whenever templates, the rubric, or the encoded rules
 * change meaning. Stamped into facts, baselines, and generated artifacts so drift against the
 * pack is computable and `harvest` has something to diff.
 *
 * v9 was claimed by a change that never shipped; the number is skipped so no two template
 * meanings ever share a version.
 */
export const PACK_VERSION = "10"
