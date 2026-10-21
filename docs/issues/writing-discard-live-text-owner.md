# recovery discard leaves a live text owner without its branch

at `d90ed1033`, recovery `claimDraft` returns the same handle held by an open text owner and increments `branchUsers` (`journal.ts:937–942`). `WritingRecovery.tsx:196` discards that branch. `discardDraft` deletes its journal memory but retains the shared handle and lock (`journal.ts:1873`); release only decrements the user count.

the retained editor still accepts input. `texts.ts:312–313` then finds no journal draft and catches `the authoring branch is unavailable`. further input remains only in the texts map. journal export, sign-out review and `writingHasMemoryOnlyChanges` inspect journal memory, so they omit this input. closing or signing out can lose it without a guard.

reproduce: edit a loaded note offline; keep its pane; open the notes recovery list and discard its branch; return to the retained pane and type. the branch must have a valid clean owner before this next input. reusing the existing clean-branch renewal mechanism with an actual saved value/version is preferable to permanently refusing recovery decisions for account-lifetime text handles.

resolved when discard removes the old authored work, the retained pane shows the chosen saved baseline, and subsequent input checkpoints, appears in export/exit review while offline, and syncs when online. a transaction-racing newer revision must remain recoverable and refuse the stale discard.
