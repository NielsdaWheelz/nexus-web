# mobile browser back does not restore workspace pane

status: open.
origin: 2026-10-14 imports experience physical qualification.
area: workspace/browser history.

on physical android chrome 155 (sm-s906w), imports `open` correctly follows the
reader in the same pane. browser history back leaves `/media/<fixture id>` and
the reader active instead of returning to imports. evidence: qualification
`back-state.json`; the product pane's `go back` is checked separately. no claim
of hardware/browser-back success is made.

reproduce: ordinary local sign-in, open usable content from imports on a phone,
then browser history back. prerequisites: real readable media and mobile workspace.
trace browser popstate and workspace route publication in their existing owners;
repair their history contract without an imports-specific router workaround.

acceptance: browser back restores the preceding imports route/pane and its query,
or the explicit product/browser history contract is documented and independently
verified. retain a physical-device receipt and delete this ticket when resolved.
