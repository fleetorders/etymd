---
"etymd": patch
---

Content screen: skip binary files, and say how many were skipped

Compressed bytes contain any short sequence eventually, so a short pattern
matches inside binary assets by accident and is reported as a "line" of
mojibake. Every pattern added to a pattern file therefore raised the
false-positive rate across every repo that holds assets.

The cost of a noisy gate is not the noise. It is that the gate's answer becomes
"bypass again", and a trained-in `--no-verify` is what eventually waves a real
finding through with the rest.

Files whose first 8KB contain a NUL byte are now skipped rather than screened,
which closes that for every pattern at once instead of anchoring one pattern at
a time. The count is reported in the summary header (`· N binary skipped`), so
"no findings" can never quietly mean "the bytes were never looked at".
