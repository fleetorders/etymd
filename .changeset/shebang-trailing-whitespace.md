---
"etymd": patch
---

Generated shell-script discovery now classifies a shebang whose interpreter name is followed
by a tab or a carriage return. `#!/bin/sh<TAB>-e` and CRLF-committed first lines previously
matched no bucket — not shellchecked, not excluded, not disclosed — so such scripts shipped
with no checker ever reading them. They now land in the checked set; a CRLF-committed script
is read and blocks on shellcheck's own SC1017 verdict instead of passing silently. Regenerate
existing hooks with `etymd gates --yes` to apply the correction.
