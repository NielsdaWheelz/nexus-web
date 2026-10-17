# library chooser

owner decision, 2026-10-15: follow main's online request → reread contract.
this supersedes the earlier specification and its implementation at `4c33ec204`.
same-tab reload recovery and immutable historical replay are explicitly dropped.
do not restore the retired replay ledger, journal, command endpoint or capture
storage subsystem.

## target

type → arrow → enter → type again → arrow → enter → escape. typing never waits
for a placement, creation or catalog request. accepted actions clear the prefix,
keep search focus and leave the chooser open. dismissal preserves accepted work
while its existing owner remains mounted.

## requirements

1. one shared action combobox for live placements and draft destinations: imports,
   share, browse/subscription and the extension. explicit actions; membership is
   descriptive, active suggestion is selection. blocked rows explain why.
2. load the complete writable named-library catalog, then match locally: exact,
   prefix, contains, then name/id. selected rows obey the same filter. no paging,
   deferred enter or server search. a failed refresh retains matching last-good
   rows and disables creation.
3. a fresh/changed query has no active suggestion. down selects first, up last;
   navigation clamps. enter activates only a deliberately active action. ignore
   repeated enter and composition; preserve modified arrows, home/end and text
   editing. accepted pointer actions also restore input focus.
4. escape/outside/tab use the existing overlay owner. at the last desktop/inline
   control, tab closes and advances after the opener; at the first, shift-tab
   closes to the opener. close/retry controls remain reachable. mobile sheets
   retain the existing modal tab cycle and close with escape. keyboard invocation
   focuses search at every width; touch invocation may focus the sheet. return
   focus to a surviving opener or its existing fallback. no new trap.
5. admission is synchronous: rejected actions retain the query. accepted actions
   freeze explicit intent. per-target fifo survives chooser close/retarget within
   the mounted provider; unrelated targets run independently. canonical membership
   changes only after reread. distinguish accepted intent from confirmed truth.
6. placement uses main's absolute put/delete and rereads after every outcome.
   never replay an unknown write automatically. a failed reread pauses that target;
   retry retries the read. failures remain visible when the picker closes.
7. draft changes are local deltas; acquisition owns publication. bulk means the
   counted current editable rows. “for new items” is a separate default control.
   creation freezes original scope, then adds only to surviving original rows,
   preserving later selections, new rows and newer query text. editing and
   dismissal stay available; final submission waits on its dependent creation.
8. creation uses a client id and frozen normalized name for the mounted attempt;
   explicit retry uses that id. check returned identity. reserved/empty/overlong
   names are unavailable; the bound is 100 unicode code points. definite refusal
   permits correction. created-library success and later placement refusal are
   separate outcomes; the library may remain empty.
9. extension destination edits are ordered explicit deltas through its existing
   background owner. save includes preceding accepted edits; discard prevents
   late resurrection. preserve credential fencing. do not reintroduce indexeddb
   or the removed resumable capture machinery.

## contracts and ownership

- `LibraryChooser`: local query/navigation; rows carry confirmed/intended counts,
  progress and an explicit set/blocked action. `onToggle({id,included}): boolean`
  and `onCreate(name): boolean` mean admitted, not committed.
- `DestinationChooser` / `DestinationField`: complete catalog through the existing
  keyed read primitive, staged destination deltas and existing surface.
- `useDestinationCreation`: current form-owned attempts and frozen scope; no
  persistence. imports/share/acquisition keep their existing admission owners.
- `placementController` / `PlacementOverlay`: mounted online placement owner,
  per-target order, canonical reads and feedback. suggestions use the same owner.
- `lib/libraries/api.ts`: typed calls and change publication. `libraries.py` owns
  catalog/authority; `library_entries.py` remains the sole membership writer.
- `extension/background.ts`, `capture.ts`, `nexusClient.ts`, `popup.tsx`: keep main's
  capture lifetime and transport. compose the shared listbox, not a parallel picker.

`GET /libraries/destinations` and `GET /extension/library-destinations` return
`{data:[{id,name}]}` for every writable named library. reject all query parameters.
`libraryDestinations(signal?)` is the web read. remove paged destination clients
and their unused branches. bump the existing global wire revision for this
incompatible shape and regenerate wire types; no new schema migration.

keep `GET /libraries/placements/{ref}`, `PUT/DELETE /libraries/{id}/items/{ref}`
and `POST /libraries {id,name}`. retain main's authority, lock order, replacement,
last-reference and transaction rules. no new command/receipt api.

## deliberate limits

full catalog increases the initial payload. per-target ordering delays dispatch,
not typing. memory-only work is lost on reload/account-owner teardown; draft data
does not acquire a recovery guarantee. an unknown delayed request can still land
after a later explicit edit: rereading does not fence it. create retry may return
a renamed live row or recreate a deleted row. there are no historical receipts.
server/web/extension cut over together; old extensions require an update.

excluded: cross-tab order, persistence/offline work, undo, fuzzy/ai search, library
index redesign, new replacement confirmation, migrations, dependencies and general
mutation/cache frameworks. do not widen main's architecture to rescue superseded
requirements.

## acceptance and delivery

temporary integration/live oracles first fail against current main, then pass
unchanged against the candidate: keyboard loop/filtering/focus; complete catalog;
current-row bulk/frozen creation; held placement response with queued inverse and
post-close drain; installed extension edit/save/discard. check canonical data,
not just optimistic rows. independently review owner boundaries and failure paths.
record exact observations and unavailable physical checks. run `./scripts/test`,
delete temporary tests/fixtures/dependencies, and retain concise qualification.

non-overlapping implementation slices: chooser/draft adapters; catalog/online
placement owner; extension adapter. integration, specification and qualification
have one root owner. cross-review each slice before merge.
