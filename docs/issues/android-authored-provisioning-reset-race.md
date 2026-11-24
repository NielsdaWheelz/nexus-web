# android authored provisioning reset can race a published snapshot

native foreground sync admits setup from an observed incomplete replica.
an obsolete setup request can still be in flight after its window goes into
the background. `apps/web/src/lib/authored/sync.ts` calls `resetProvisioning`
after fetching its snapshot. `apps/android/app/src/main/java/app/nexus/android/authored/AuthoredStore.kt`
clears corpus tables on reset even if another native bridge has published
provisioning. the ready fact can then describe an empty or partial corpus.
this is a source finding and needs a two-owner reproduction.

resolve when an obsolete reset after another owner's publication cannot change
the ready corpus, and an interrupted unpublished setup can still restart.
