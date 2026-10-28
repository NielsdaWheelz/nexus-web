# share capture submitted work guard

`app/share/ShareCapture.tsx` registers failed/uncommitted local plain-text writing with workguard, but URL acquisition `saving` and `useDestinationCreation(...).readUnconfirmed()` are not registered. the native share back/exit guard can therefore close while these submitted server operations remain unacknowledged.

register these actual attempts in the existing share owner. resolved when exiting during an in-flight or uncertain URL/destination save offers the existing stay/discard decision, and acknowledged operations no longer block exit.
