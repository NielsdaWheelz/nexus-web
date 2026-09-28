# media rows lost their offline download status

status: open · origin: 2026-09-27 cleanup PR 01 (offline audio enqueue) · area: collections / offline audio

`aada476d5` (#385) removed the last `useOfflineMediaItem` caller
(`PodcastEpisodeList.tsx`). every presenter now sets `localAvailability: absent()`:
`apps/web/src/lib/collections/presenters/{podcast,media,library,search,browse,note,settings,paneFind,conversation,presentContributorWork}.ts`
and `apps/web/src/lib/resonance/presentSlateItem.ts`. that leaves
`apps/web/src/components/collections/CollectionRow.tsx:69-134,320-355` and
`apps/web/src/lib/collections/types.ts:71` dead. cleanup PR 01 deleted
`useOfflineMediaItem` and the store's keyed item subscription, so the only live
source of local state is the ordered inventory.

the choice is a product call: restore row status by projecting
`store.getInventory()` by media id in the podcast/media presenters, or delete
the field and the rendering.

acceptance: either episode rows show download state again from the inventory,
or the field, its rendering and the `absent()` lines are gone.
