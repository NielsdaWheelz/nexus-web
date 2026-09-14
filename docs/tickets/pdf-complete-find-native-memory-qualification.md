- status: open
- origin: 2026-09-14 bounded-workspace implementation, run `35d417c7413b4d3e`
- area: pdf complete find / browser native residency

the actual range-capable 100 mib/200-page fixture opens after receiving about
1.1 mib. complete find reads all 100 mib and finds every labeled page, but
observed aggregate chromium private footprint rises from 180.2 mib baseline to
578.3 mib, then 404.2 mib after reader unmount and main-isolate gc.

evidence: `test-results/runs/35d417c7413b4d3e/pdf-loading.json`;
`apps/web/src/components/PdfReaderLoading.browser.test.tsx`. these are sequential
scenarios with native tracing overhead. network settlement and main-isolate gc
do not establish worker destruction or allocator reclamation; this is an open
capacity question, not a proven leak. the fixture isolates encoded byte demand,
not dense image/operator decoding.

repeated workload `beecff200b23a979` verifies that every physical pdf worker
terminates. after-close aggregate footprint reaches 408.8, 543.4, then 536.0 mib
over three 100 mib cycles; javascript heap stays near 19 mib. this still enabled
devtools response preservation. chromium defaults to a 200,000,000-byte desktop
inspector response buffer; the measurement can retain downloaded source bodies.
run `71a0ec6153e39a8d` sets both network preservation limits to zero, keeps actual
transport byte events, and disables network inspection after settlement. three
100 mib cycles settle at 283.0, 340.5 and 340.3 mib after close; the largest find
sample is 509.8 mib. this identifies substantial inspector overhead, but still
uses native tracing. source: chromium's [network inspector](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_network_agent.cc)
and [resource buffer](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/network_resources_data.cc).
no attribution to an
application leak or acceptable mobile budget follows from the earlier run.

run `3ded772cd3a2d41f` replaces linux native tracing with actual owned process
`smaps_rollup` reads. its five pdf cases pass; the enclosing run fails afterward
on an artwork proof's same-origin blob fetch. aggregate private resident memory
after the three 100 mib closes is 315.4, 377.0 and 382.1 mib; the largest find
sample is 565.4 mib. observed browser swap is zero, every worker disappears,
and released main-isolate heap remains about 19 mib. rss sums include shared
pages and are reported separately; summed process lifetime high-water marks are
not concurrent peaks. these measurements still include the component harness,
byte-event inspection and explicit main-isolate collection. they are not final
device or production qualification. both runs use chromium `147.0.7727.15`,
revision `6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`.

prerequisites/fix: finish the actual worker/reader lifetime receipt, distinguish
live retained buffers from allocator residue, and qualify repeated complete-find
and close cycles through the existing capacity owner. repair retained ownership
or excessive representation copies where observed; preserve complete find.

acceptance: maximum supported pdf workloads and repeated reader cycles stabilize
within committed browser/device budgets, with physical worker cancellation and
no missing matches; final capacity measurements exclude profiler overhead.

considered seam: hosted pane find currently uses `usePdfPaneFind` and the exact
`PdfFindRuntime` match/presentation owner. selected-publication `/find` queries
text units and returns web/epub fragment offsets; pdf has retained canonical
page spans for quote resolution, but no corresponding complete-find result
contract. a server projection would need selected-asset attestation, pdf.js
normalization/whole-word parity, and exact page-local match mapping before
replacing the local query. qualify current worker reclamation first; this is
not an existing interchangeable backend capability.
