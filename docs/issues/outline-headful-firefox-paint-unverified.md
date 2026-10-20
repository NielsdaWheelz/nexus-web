# headful firefox painting remains unqualified

the retained firefox-1511 executable/profile launched through playwright's
headful juggler pipe accepted dom changes and keyboard input, but animation-frame
callbacks did not run and the visible mac window stayed stale. dom success cannot
establish paint correctness. the cause is undiagnosed; this is not evidence of an
outline rendering defect.

reproduce with playwright's persistent headful context, `marionette.enabled=false`
and the firefox-1511 executable. race one animation frame against a one-second
timer after navigation, then compare dom state with paint and native pointer
actions. the observed launch included `-juggler-pipe`; clicks and bring-to-front
also hung despite a ready, visible document.

the same executable/profile through headless raw marionette ran animation frames
and produced screenshots at native page/text zoom. that entrypoint qualifies the
headless engine only. no rendering preference was added.

resolved when an isolated headful launch paints the current outline and completes
animation frames, with its actual launch path and any required environment repair
identified. the profile must have only one owner; preserve its isolated login.
