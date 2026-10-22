---
"etymd": patch
---

The comment-truth lens now discloses every skip class its shared checks can reach:
workspace-filtered command mentions, path claims sitting beside the URL they are fetched
from, doc mentions named only to say they deliberately do not exist, and slash tokens
carrying a namespace label (`app:src/x.ts` shape). All four were counted by the same checks
the instruction-file lens runs and silently dropped from the comment report — a skip class
that is counted and never named is a silent coverage hole.
