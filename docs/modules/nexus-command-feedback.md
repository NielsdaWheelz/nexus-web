# nexus command feedback

`useNexusFind.ts` owns query-selection learning; `useNexusController.ts` owns
creation admission and domain copy. `apiTransportFeedback` owns transport
wording. [recent resources](recent-history.md) owns local history failure
separately; a ranking failure never changes recent history.

an accepted eligible selection sends exactly query and target href. the send
closure retains its serialized body, coalesces concurrent sends and offers
`retry save` only for the latest selection. a lost reply may make an explicit
retry count the selection twice; these are ranking statistics, not an
idempotent resource write or a history replay. successful acknowledgement
invalidates frecency. offline selection learning does not queue a later write.

auth recovery runs first. admitted transport errors produce the shared
`selection not confirmed` feedback; unknown errors remain defects. selection
eligibility belongs to each row's `learns_selection`, not its displayed label.

creation retains its own frozen command identity and accepted domain-error
codes. transport feedback takes precedence over domain copy; an unrecognized
error reaches the existing defect owner. changing a retryable creation's name
rotates its identity; an unchanged retry retains it. delayed creation and focus
handoff follow the existing workspace activation contract.

there is no retry-save action for local history. failed reads reread storage;
uncertain writes are checked without replay. pending local history never
participates in `WorkGuard` or makes a successful navigation fail.
