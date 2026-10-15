# link target picker handles composing enter as activation

status: open · origin: 2026-10-14 library picker audit, adjacent finding · area: web / resource links

problem: the link target input has no composition guard before enter activates a target.

evidence: `apps/web/src/components/resources/LinkTargetDialog.tsx:125-140` calls `pick(active)` for every enter; `:155-169` wires that handler without composition events. `pick` invokes `composer.confirm` at `:112-121`. `PeopleSearchCombobox.tsx:83` provides an existing composition-state/native-event guard precedent. source-derived hazard; browser/input-method reproduction remains required.

prerequisites: none. this is adjacent work, separate from library picker implementation.

fix: preserve composition and modified text editing keys before processing list navigation or activation.

acceptance: using a composition input method, enter accepts the candidate text without creating a link; ordinary enter still links the selected target afterward.
