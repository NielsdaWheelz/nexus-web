# focus refresh can consume a retry press

in firefox, a retry that is enabled at pointerdown can become blocked before
click when focus refreshes model recall. the press sends no request; the short
`choose a model.` reason disappears when the read finishes. a subsequent
stable-focus keyboard activation admits the retry. the first press therefore
looks lost even though the readiness guard correctly refuses an unread choice.

observed at `d964629d5`, lab `20261113-005017-e2bfc38a815f`: enabled pointerdown
at 577ms, blocked recall at 608ms, blocked click at 620ms, ready at 646ms.
the command owner remained active, idle and able to execute. the private
`librarian-leaves-retry-android-node-firefox.private.json` retains the gesture
trace and the subsequent accepted retry. regression status against main has
not been checked.

the relevant contracts are model freshness in
`apps/web/src/lib/chat/selectionMemory.tsx:30`, pane entry in
`apps/web/src/lib/panes/indexPaneEntry.tsx:107`, and the blocked verb in
`apps/web/src/components/feedback/Fact.tsx:71`. resolve when a first enabled
retry press on a freshly focused window either admits the exact current choice
or leaves an actionable refusal, while preserving selection freshness.
