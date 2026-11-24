# development effect replay can retire the mounted chat command owner

next enables strict mode by default for the app router. in a development
mount, effect replay can run the shell's `useChatWorkOwners` cleanup, which
calls `suspendChatCommands` and retires the current account's command owner.
`ChatSelectionProvider` and `Librarian` memoize that owner by account id.
replaying the effects does not reacquire their memoized owner. a later pane
mount can get the replacement owner while the catalog observer still listens
to the retired one.

this is a source finding in `apps/web/src/lib/chat/{drafts,commands,selectionMemory}`
and `apps/web/src/components/chat/Librarian.tsx`. canonical lab and release
builds use production react. reproduce in a strict development mount. close
when an initial librarian mount and a later reader handoff share a live owner
after replay, and a definitive stale refusal still refreshes the catalog once.
