# fresh-selection link completion clears a later selection

- status: open
- origin: 2026-09-14 bounded reader selection audit
- area: hosted text link creation

`MediaPaneBody.tsx:5565` clears the current browser/retained selection after a fresh-selection link commits. `freshSelectionLinkSessionRef` records only a boolean, so it cannot identify the selection that initiated the link. a later selection in the same reader can be erased. the same owner also relies on the selection-null effect to unlock action state.

prerequisite: reproduce with a held link write and a later reader selection. retain the initiating selection in the existing link owner, clear only that selection on success, and unlock at the existing completion/close boundary. preserve committed link outcome and ordinary cancel behavior.

acceptance: successful or failed old link completion leaves later selection intact and permits its next action; ordinary completion withdraws only the initiating selection.
