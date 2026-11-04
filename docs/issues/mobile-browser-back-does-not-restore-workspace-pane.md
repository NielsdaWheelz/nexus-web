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

## 2026-11-01: 390px headless chromium, reader connections

the same failure from a second route. connections-scroll lab, `61562d112`, playwright chromium at
390x844 with touch: open a book (generated stress epub, and standard ebooks' meditations), `all`
connections, scroll, click a linked note row's `/notes/<id>` link. the note opens in the single
mobile pane (`panes 0`, no `Go back in this pane` button), and after `page.goBack()` the page is
still `/notes/<id>` 12s later in all 4 cells (two books, two speeds). no cell returned to the media,
so the return case (connections-scroll a6) runs
on desktop lanes only and the phone return is proved by hand. evidence: lab traces
`a6-chromium390.json` and `chromium390-return-*-noback.png` from the red phase.

reproduce without hardware: `./scripts/lab` driver at 390x844 chromium, open media, open a linked
note from the connections list, `page.goBack()`; expect `/media/<id>` with the pane restored.
