# android offline restart remains unqualified

the isolated android qualification stalled after restarting the application with
its web transport disconnected. restart returned a new page, but the workspace
readiness assertion did not finish; subsequent cdp cleanup also stalled. the
initial startup cause is unresolved and must not be attributed to pane ordering.

evidence: source `eb36fb55e`, run `20261028-182123-56e062fbbd86`, private api-34
emulator and canonical debug apk. drag and tap placement each advanced the native
workspace revision once; same-rank placement did not. the recovered native
startup file retained revision `2`, the complete expected pane order and metadata.
no writing loss was observed.

resolve with bounded native startup/renderer diagnostics and an independently
reproduced offline process restart. establish that the stored workspace renders
and accepts input while disconnected; keep this separate from online restart,
which does not prove offline startup.
