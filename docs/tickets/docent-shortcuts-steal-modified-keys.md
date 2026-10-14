# docent shortcuts steal modified keys

status: open · origin: 2026-10-14 shortcut-removal review · area: web / chat, keyboard

`apps/web/src/components/chat/Docent.tsx:16-21,73-85` maps `n`, `p` and
arrows by `event.key` alone. it excludes prevented events, overlays and some
typing targets, but ignores modifiers and composition. with a walk active,
command/control+p can move to the previous source and prevent browser print.
the document listener also leaves plain character shortcuts independent of
focus in the walk controls. this is source review, not a browser reproduction.

impact: a walk can intercept browser commands and keys intended for other
components. prerequisites: a conversation with a multi-source walk.

fix: own navigation in the focused walk component; reject modified and
composition events, use the shared editable-target predicate, and remove
character aliases unless their focus scope is explicit.

acceptance: during a walk, command/control+p retains browser printing; modified
arrows and composition do not navigate; documented unmodified navigation works
only while its component owns focus, with visible controls still usable.
