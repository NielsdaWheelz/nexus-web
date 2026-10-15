# x reader bare-route position not restored

status: investigating; production consumer acceptance failed
origin: 2026-10-14 session-entry consumer check, settled `3839b96a0`
area: web reader / initial saved-position restoration

the consumer owner opened bare `/media/114a5cc0-bed9-4f3c-b069-b84702abfdd9`
without query, hash, input or scrolling. canonical fragment/window hashes match,
but after 20 seconds `scrollTop=0`, maximum `561`; the saved endpoint is 914 px
below the reading line, without an observed clamp. this is failed reopening,
not evidence that server remapping lost the position.

a read-only postgres check at `2026-10-15T00:52:45Z` confirms the complete saved
cursor, publication, snapshot and fragment collection still match the handoff:
cursor revision `6`, owned fragment `826c3bed-826d-482c-a338-c1f5dc08b065`,
code-point offset `134`, publication generation `3`. receipt:
`/private/tmp/nexus-x-titles-proof-20261014/production-114a-consumer-failure-db-read.json`.

the consumer's later authenticated api-document navigation returned http 200 with
the exact saved locator at `2026-10-15T00:57:21Z`; it does not capture the first
mount's response body. original page resource timings show 200 responses for
reader-state, reader and document-map. visible/focused state and 121 animation
frames in 1,005 ms rule out frame suspension. the owning region is unique; the
active pane is mostly horizontally clipped. its scroll range later grows to
1,347 px while the saved endpoint remains 1,700 px below the reading line and
`scrollTop=0`. no initial zero-range clamp was observed.

evidence: `/tmp/nexus-session-entry-release-20261014/firefox-qualification/`:
`114a-restore-observation.json`, `114a-active-pane-address.json`,
`114a-preserved-geometry.json`, `114a-frame-scheduling-before-foreground.json`,
`114a-cursor-direct-document.json`, `114a-passive-reading-position-status.json`.

an isolated actual-react/runtime/text-surface probe now proves a sufficient
vertical mechanism: restoration settles while the initial scroll range is zero;
a delayed real image expands by 1400 px, but passive reflow preserves the
clamped measured passage instead of the saved logical endpoint. final endpoint
is 1490 px below the line, with zero input/save calls. receipt:
`/tmp/nexus-session-entry-release-20261014/reader-qualification-receipts/frozen-layout-red.json`.
this does not establish the unobserved initial sequence of the production visit.
the horizontal mechanism is tracked in
[the canvas ticket](resume-scroll-misses-late-pane-growth.md).

prerequisites: pin initial positioning and layout transitions, not only the later
authenticated response and final geometry. trace restoration at its owning boundary; reproduce
before changing code. the physical consumer owner retains browser/phone control.
no source/model/refresh call, main advance or publication has occurred during
this investigation. the concrete forward correction is flagged and will ship
as one reviewed candidate. book repair stays held.

acceptance: the unchanged saved locator restores on an ordinary bare-route open
in the actual consumer, with correct fragment/offset, explicit geometry/clamp
accounting and no injected navigation or incidental save. preserve the before and
failed receipts; requalify affected restoration behavior and delete temporary checks.
