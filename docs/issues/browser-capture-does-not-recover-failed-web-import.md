# browser capture does not recover a failed web import

ordinary browser capture creates a separate media instead of repairing the
failed url import. the original remains unresolved and its filing and identity
do not follow the captured article. source-derived review; no live reproduction.

evidence: `python/nexus/services/media_upload_sessions.py:179-182` returns no
capture target for ordinary urls. confirmation at `:554-574` replaces only a
bound native x article, otherwise matching an account/kind/packet digest;
`:665-677` creates a new browser-capture media. the existing x contract at
`:284-335` checks media identity, ownership, expected attempt and reader
generation. `apps/web/src/lib/imports/copy.ts:195-200` nevertheless recommends
browser capture after source access denial.

the imports inspector displays that instruction but only offers retry/repair
(`apps/web/src/components/imports/ImportInspector.tsx:260-279`). the reader's
source action at `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:811`
uses the ordinary anchor in `apps/web/src/components/feedback/Feedback.tsx:323-333`,
so following it leaves the app in the same tab. expose one browser recovery
capability consistently, with an explicit new-tab source link and extension
confirmation naming the failed import.

reproduce: import an ordinary article whose server fetch fails; open it in a
browser where its body is readable; capture with the extension; inspect the
original media and imports attention state.

extend the guarded capture target to failed ordinary web imports. publish a
new attempt onto the same media, preserve failed history and current filing,
and expose the remedy from the source recovery owner. ambiguous urls require
explicit target selection; stale or removed targets must not become new saves.
readable-content replacement also depends on the separately recorded ordinary
web cursor preservation issue.

identity constraints: `media_source_ingest.py:248-256,479-489` uses
`canonical_url` for global reuse and grants the importing viewer holdings.
authenticated capture bytes must not enter that global lookup; use an
account-scoped association with the original import. failed media can already
hold a canonical key if later preparation failed, so check this explicitly.
settled url reuse at `:526-555` also appends the incoming source type: re-adding
a recovered source must retain browser-source provenance and must not make
server refetch authoritative again. capture confirmation at
`media_upload_sessions.py:612-615` currently applies filing commands; recovery
must preserve current filing without replaying them.

resolved when capture recovers the same media without duplicate filing or
remaining source attention, retries converge, stale capture cannot overwrite a
new publication, and the failed attempt remains visible in history.
