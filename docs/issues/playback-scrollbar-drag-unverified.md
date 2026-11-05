# playback rail scrollbar drag remains unverified

problem: acceptance 14 requires the pane scrollbar to remain draggable over the rail's six-pixel overhang. the retained headless cases do not exercise a real scrollbar drag.

evidence: lane 5 repair report at `81041e1ed` reports this case skipped in chromium and firefox because headless playwright renders no canvas scrollbar; `cases/l5/bar-geometry.spec.ts` retains the skipped observation. the unconditional canvas-edge hit check proves only hit ownership.

impact: pointer competition between the rail and a visible scrollbar is not qualified.

takeover verification at `b3d9a2e45661b2b9bd8c4f4ac13b04429b390f9e`: the canonical cases again skipped in both engines, reporting no rendered scrollbar. `verify/takeover/browser-first.log`, cases 12 and 17, lab `20261102-181216-e885e8b68893`. the adjacent unconditional overhang hit checks passed in both engines.

resolved when: the owner drags the real pane scrollbar across the rail edge in the supported browsers, or a permitted headless configuration renders that scrollbar and the case observes an actual successful drag. no desktop access is authorized for the build.

installed-input qualification belongs to [the paired playback release](release-playback-bar.md).
