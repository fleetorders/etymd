---
"etymd": patch
---

The test runner's vite dependency moves to 8.3.5, the fix for three launch-editor advisories
(GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw) affecting 8.2.0 through 8.2.2. It
is reached only through vitest, a development dependency, so nothing changes for anyone installing
etymd.
