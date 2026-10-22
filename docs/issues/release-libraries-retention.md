# release libraries retention and ordering

status: implemented and locally qualified; release pending. contracts live in
[the library module](../modules/library.md) and [ingest](../modules/ingest.md).
no deployment has been authorized.

before release: one migration after actual head; stopped writers and verified
backup under the existing deploy controller. report per-viewer visible all-media
counts, missing default holdings and historical entry-undo receipts affected.
verify the migration preserves ids, added times, removal markers and subscriptions.
pending unpublished uploads use existing file reselection/re-upload or recapture
after cutover; live-owner confirm-only recovery does not survive release/reload.
the new confirmation captures reviewed guards; published receipts stay read-only.
queued source/tool/research work must use the new contract
or be explicitly cancelled before resuming; never fabricate historical guards.

pair api, workers, web and extension with the generated wire/tool contracts.
the disposable runtime pairs the manifest's firefox callback origin explicitly;
native qualification builds the addon for that run's exact web/storage origins.
follow the existing wire revision release rule; old clients must fail explicitly.
the android shell uses the paired web capture flow; no native payload changes.

before merge, rehearse migration 0308 on the newest production backup. local
disposable qualification does not replace that data rehearsal. keep proof and net
authored/deleted lines in the pr. delete this record once release steps complete.
