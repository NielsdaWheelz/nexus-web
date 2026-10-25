# signout must account for durable unsynchronized writing

target gap: local-first writing makes device storage authoritative before server
acknowledgement. its removal can discard the only committed copy.

evidence: `apps/android/app/src/main/java/app/nexus/android/DeviceSession.kt:427-454`
retires the local account before cleanup; `:462-476` purges stores and calls
`WebStorage.deleteAllData()`. current live-writing guards precede that path, but
they do not define a new durable corpus's purge contract.

impact: adding authored browser/native storage without changing lifecycle
admission can silently delete unsynchronized writing at signout.

resolved when explicit signout either completes synchronization or obtains a
deliberate discard of remaining local-only changes before destructive cleanup,
and interrupted cleanup cannot expose one account's data to another. ordinary
session expiry must pause remote sync without pretending that a device-local
save failed. this is a lifecycle requirement, not a recovery interface.
