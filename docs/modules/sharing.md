# inbound capture sharing

this module owns android system shares and the `/share` web surface.
[resource sharing](resource-sharing.md) owns grants and anonymous reading.

## boundaries

`ShareActivity.kt` receives `ACTION_SEND` text, trims it, finishes empty native
shares and loads `/share?text=...`. it consumes only `nexus-share://open`, `done`
and `dismiss`. the shell calls no capture, library or auth api directly.

`apps/web/src/app/share/*` owns the compact web capture card outside the
app shell. an empty browser share shows its empty state. url capture starts only
on save; cancel admits nothing. `DestinationField` and `DestinationChooser`
reuse the ordinary named-library catalog and creation owner. zero named
destinations is valid; all is never an organizational choice.

## url admission

the destination read returns `{removal_revision,destinations:[{id,name,order_revision}]}`.
the chooser preserves the revisions actually reviewed. original save freezes the
removal revision before provider work and sends a client-minted attempt `id`,
`url`, `expected_removal_revision` and `destinations:[{library_id,expected_order_revision}]`.
multi-url shares freeze one removal snapshot and preserve each url's own command.
retry only unresolved targets, retaining their exact id and guards.

the source owner compares every guard before acquiring personal retention and
named placements atomically. default/system ids, duplicates, inaccessible and
member-only destinations are refused. accepted destination no-ops advance their
library revision. stale intent requires fresh explicit review; recovery never
silently substitutes newer guards.

an existing source receipt returns its historical identity without acquiring or
filing again. the client rereads current availability and placements before
claiming current saving. after normal receipt teardown, stale original removal
guards still prevent acquisition replay. a new save is new explicit intent.
[libraries](library.md) owns membership, revisions and capabilities;
[ingest](ingest.md) owns receipts and publication.

## text and uploads

non-url text reads `/me`, freezes one account-local date and sends the dated
daily-capture command. retry keeps that date across midnight. profile failure
admits nothing. this note flow has no media destination picker.

file upload and extension capture use the shared guarded confirmation contract.
final confirmation owns destinations; stale choices refuse all publication and
filing. a live request owner can review and confirm the same uploaded generation
before expiry. unknown confirmation retries its frozen body; reload or owner loss
requires existing re-upload or recapture. no authored content, admission identity
or confirmation state is persisted in browser storage.

## scope

no android `ACTION_SEND_MULTIPLE`/`EXTRA_STREAM`, native product client, non-url
library picker or separate post-save filing path.
