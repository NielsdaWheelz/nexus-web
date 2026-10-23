# offline shelf playback controls

deferred by owner decision: the saved native queue supports prepared downloads
without a webview, but a cold offline launch has no shelf controls for resuming
or editing that queue.

`apps/android/app/src/main/java/app/nexus/android/MainActivity.kt:414` routes cold
offline launch to the shelf. `apps/web/src/shelf/Shelf.tsx` and `ShelfReader.tsx`
have no queue surface; native playback remains owned by `NexusPlaybackService`.

resolved when a cold offline launch can bind the retained account and resume its
saved queue through shelf controls, using the existing native queue contract and
descriptor authority. keep one native cursor; do not add a shelf queue replica.
