# recovery discard leaves a live text owner without its branch

at `d90ed1033`, recovery `claimDraft` returns the same handle held by an open text owner and increments `branchUsers` (`journal.ts:937–942`). `WritingRecovery.tsx:196` discards that branch. `discardDraft` deletes its journal memory but retains the shared handle and lock (`journal.ts:1873`); release only decrements the user count.

the retained editor still accepts input. `texts.ts:312–313` then finds no journal draft and catches `the authoring branch is unavailable`. further input remains only in the texts map. journal export, sign-out review and `writingHasMemoryOnlyChanges` inspect journal memory, so they omit this input. closing or signing out can lose it without a guard.

reproduce: edit a loaded note offline; keep its pane; open the notes recovery list and discard its branch; return to the retained pane and type. the branch must have a valid clean owner before this next input. reusing the existing clean-branch renewal mechanism with an actual saved value/version is preferable to permanently refusing recovery decisions for account-lifetime text handles.

resolved when discard removes the old authored work, the retained pane shows the chosen saved baseline, and subsequent input checkpoints, appears in export/exit review while offline, and syncs when online. a transaction-racing newer revision must remain recoverable and refuse the stale discard.

lab 5 confirmed the red at `d4c6d036b`: the recovery row disappeared and the retained pane kept its identity, but its next input reported `recent changes are only in this tab.` (`durable-browser-discard-fr-a7439-ical-editor-s-next-revision/error-context.md`, assertion at `durable-browser.spec.ts:117`).

source repair: `discardTextDraft` routes a real confirmed baseline into journal discard. immediately after deletion commits, journal chooses the newest actual numeric baseline from that input and the current owned base/canonical conflict, preserves the current context in a revision-zero clean seed, and publishes before awaiting any refresh. text adopts that seed synchronously; its next edit uses existing branch renewal. no-baseline owners become unavailable. live qualification remains pending.
