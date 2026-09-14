- status: open
- origin: 2026-09-14 bounded-workspace source activation review
- area: note source activation / pane identity

the note branch of `apps/web/src/lib/conversations/readerSourceActivation.ts`
still dispatches a block-id pulse without the destination pane id. the existing
`NotePulseTarget` and note editor listener can therefore deliver one source
activation to multiple panes displaying that block. media source activation is
being bound to the workspace's accepted pane; that correction does not attest
note destination isolation.

prerequisites/fix: reuse the accepted workspace destination and the existing note
pending delivery/editor owner. preserve exact note offsets and current editor
activation semantics; do not add a second event registry.

acceptance: with the same note open in two panes, source activation positions and
pulses only the accepted destination, including delivery before its mount and
close/supersession before delivery.
