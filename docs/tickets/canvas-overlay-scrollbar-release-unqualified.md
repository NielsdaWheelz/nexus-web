# overlay scrollbar drag release is unqualified

status: unverified; no successful thumb motion observed, no defect established
origin: 2026-10-14 consolidated reader/canvas qualification, hook `ac453eb03`
area: workspace / native scrollbar input

the actual-hook browser proof passes a classic 15-px canvas scrollbar-gutter
drag. the default overlay-thumb attempt delivered a pointer but produced no
scroll movement, so it proves neither release nor a failure. other horizontal
pan controls and nested-scroll preservation passed. receipts:
`/tmp/nexus-session-entry-release-20261014/canvas-qualification/case-index.json`.

qualify real native overlay-thumb movement without changing product markup or
inventing hit zones. then grow a preceding pane; the deliberate pan must remain
released. preserve the actual input/scroll/layout evidence. change the owner
only if that experiment demonstrates a defect.
