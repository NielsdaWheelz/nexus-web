# overlay history discards forward navigation and leaves dead entries

problem: opening a modal pushes a synthetic history entry. this discards any
existing forward history. closing through the ui traverses that entry off but
leaves a no-op entry ahead; reloading an open modal leaves a dead back entry
because the modal is not restored from history state.

evidence: `apps/web/src/lib/ui/overlay.ts:252-261` pushes the marker on modal
admission and calls history back on close. `:272-289` consumes traversals without
restoring modal content. `docs/modules/overlays.md:151-155` explicitly documents
these costs. no new browser-history journey was run in this audit.

impact: browser forward/back behavior changes merely from opening a modal.
using modal sheets for every mobile action menu would make this existing
compromise substantially more frequent.

resolution: qualify and explicitly choose the shared overlay history contract
before broadening its use. any repair belongs to the overlay kernel, with
navigation, dismissal guards, nested surfaces and modal handoffs preserved;
do not create menu-specific history ownership.

resolved when the chosen contract is explicit and verified for forward history,
ui close, back close, reload and menu-to-dialog handoff, with dead entries either
removed by an actual kernel repair or retained as an explicit product constraint.
