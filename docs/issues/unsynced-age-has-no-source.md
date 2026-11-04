# unsynced age has no source

a long outage cannot say how long changes have stayed local: pending commands
have no persisted timestamp. restarting an in-memory clock cannot establish
their age, so account feedback never escalates by days outstanding.

`node/authored/src/schema.ts:21` defines `pending_changes` as `command_seq`,
`change_json`, `byte_length`. browser `lib/authored/persistence.ts` and android
`authored/AuthoredStore.kt` both insert those three values. adding a timestamp
requires a migration in both durable stores and paired clients; a presentation
timer is insufficient.

resolved when the oldest pending time survives browser and android restarts
and the account can derive its age from that persisted fact.
