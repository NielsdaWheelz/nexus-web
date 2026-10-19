# phone landscape exceeds the mobile layout cutoff

status: open
origin: 2026-10-11 scrollbar verification; baseline `39dfa94568`
area: workspace / viewport classification

the isolated pixel 7 emulator on android 15 (api 35) reports a `915x412` css viewport,
coarse primary pointer and no hover in landscape. the mobile query at
`apps/web/src/lib/renderEnvironment/provider.tsx:14-15` requires at most 900px
for coarse landscape, so it classifies this phone as desktop. the same query
appears in mobile chrome/layout styles. scrollbar policy now follows input
capabilities independently, but the workspace classification remains.

evidence: native webview `124.0.6367.219`, task-owned `emulator-5578`, matching
query evaluated in a fixture importing the current shared reader. this is
viewport/query proof; the full hosted workspace was not exercised.

impact: a phone in landscape can receive desktop workspace navigation and
reader controls. the scrollbar correction alone does not qualify that layout.

proposed fix: qualify a coherent phone/tablet layout boundary against supported
viewport and primary-input combinations, then update its query owners together.

acceptance: the hosted workspace on this phone retains usable navigation,
reader controls and chrome clearance in both orientations; desktop and tablet
layouts remain intentional. record device, served artifact and observed flows.
