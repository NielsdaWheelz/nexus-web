# offline navigation after worker disconnection

a chromium qualification case remained at `preparing your notes` for 20 seconds
after full offline navigation to `/notes`. product failure versus driver-induced
shared-worker lifetime remains unresolved; this is not evidence of lost writing.

evidence: commit `eb36fb55e`, lab run `20261028-180922-f9cc7a84bf7c`. the driver
made both the page and its exact authored shared worker offline through cdp,
edited a real page title, and queried the production worker protocol. the title
was committed and the current command sequence was not uploaded. saved-on-device
status and zero-confirmation pane close both passed. only subsequent full
navigation stalled.

resolve by reproducing offline navigation with controlled worker shutdown and
network isolation independent of this cdp attachment. identify whether the
worker or startup owner stalls; qualify the retained title and workspace after
reload. the pane-list change does not alter authored startup or storage.
