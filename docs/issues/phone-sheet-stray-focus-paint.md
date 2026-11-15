# phone programmatic focus paint

observed 2026-11-15 at `42618db32`, chromium 390×844 with protocol touch; no
handset observation. choose-create and browse headings paint focus rings as if
they were fields. the old close flow also left a neighbour × tooltip standing
across dismissal/reopening, contrary to the touch tooltip contract.

the thumb index removes the initial armed-row focus box and the neighbour ×
focus flow: opening focuses the hidden heading, marking focuses its primary
button, and current close dismisses the sheet. recheck the old tooltip symptom
under these paths; the child-page heading paint retains its focus owner.

evidence owners: `components/switchboard/SwitchboardTask.tsx`,
`components/nexus/NexusPages.tsx` and the shared control tooltip. impact is paint
that implies keyboard input or covers a title after a touch action.

resolve when touch opening/marking/current close and both child pages show no
stray ring or tooltip, while a hardware keyboard retains its focus indication.
