# firefox action acknowledgement can stall in the lab

headless firefox can exceed the lab's 15s action deadline after dispatching a
reader-theme radio click or focusing the source scrollport. failure screenshots
already show the selected light radio or a correctly painted visible reader,
so this does not establish a running-head rendering failure.

evidence: source `68836fa2f`, playwright 1.64.1, lab
`20261112-233347-40e6f2601775`, firefox room/theme case. the call log reaches
visible/enabled/stable, scrolls the `Light` menuitemradio into view, then times
out at `performing click action`. the actual page screenshot retains the open
view menu with light selected. the second repeat timed out in `port.focus()`
with the reader visible. the cause and dispatch-to-paint timing remain
unestablished; host load and browser-protocol acknowledgement are not isolated.

reproduce with repeated room reloads and real reader-theme choices through
`openLabBrowser`, retaining click and UI-mutation timestamps. a larger explicit
visual-case deadline can qualify rendering but does not explain this stall.
resolved when the cause is identified and normal action acknowledgement is
bounded, with UI response and protocol latency reported separately.
