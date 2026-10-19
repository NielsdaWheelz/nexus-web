# pane tabs wide touch remains unqualified

status: blocked · origin: 2026-10-16 pane-tabs implementation · area: workspace / physical pointer qualification

problem: physical touch dragging of the desktop pane strip has not been verified.

impact: mouse dragging and mobile manage-tabs checks cannot establish the real
long-press, native scroll, release-click and cancellation behavior of a wide
touch layout.

evidence: final product `83f3473f7` passed management on samsung sm-s906w,
android16, chrome155 and the isolated app's webview154. landscape widths were707px in
chrome and780px in the shell; both correctly retained mobile composition under
`apps/web/src/lib/renderEnvironment/provider.tsx:15`. no desktop strip appeared.
see #653 for final source and outcomes.

prerequisite: a physical coarse-pointer browser with an actual desktop workspace
layout (landscape mobile classification extends through900csspx).

acceptance: use real touch to scroll before pickup, hold to pick up, reorder in
both directions and to an overflow end, cancel outside/escape/pointercancel,
and verify one commit, unchanged active pane, usable focus and a fresh tap.
viewport or density emulation does not qualify the physical-device gate.
