# libraries dialog physical keyboard clearance is unverified

status: blocked on device availability
origin: 2026-10-15 libraries creation qualification; branch `codex/libraries-creation-20261014`
area: libraries / mobile presentation

the new dialog passes chromium mobile emulation, but emulation does not prove
soft-keyboard clearance. the samsung `SM_S906W` disappeared from `adb devices -l`
before acquisition. the owner confirmed it is unavailable until morning.
this session issued no device mutation; no reverse, forward, chrome launch or
foreground change occurred. the reservation was released to inspector.

prerequisites: reconnect the handset with debugging available, coordinate a
fresh acquisition window, and confirm the current foreground before changing it.
use this task's isolated web `3291` and api `8291`; preserve other sessions'
services, tabs, mappings and data.

acceptance: on the physical handset, open `new library`, focus name with the
actual keyboard shown, and verify field, validation error, submit and close are
reachable without horizontal overflow. exercise a correction and creation;
read the created id through the public api, then delete only that fixture.
record device/browser, viewport, keyboard evidence and screenshots. restore the
acquired foreground and remove only task-owned tabs/mappings. if obstructed,
repair the demonstrated geometry at the existing dialog/viewport owner and
verify affected consumers. no full completion claim before this check passes.
