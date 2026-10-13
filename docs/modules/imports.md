# imports

owner: `services/imports.py` composes and reads; source, search, and metadata owners supply their facts and recovery policies. `schemas/imports.py` and `schemas/import_history.py` own the output contracts. the web presents those facts through `apps/web/src/lib/imports/`.

## obligations

an import has independent `source`, `search`, and `metadata` presence slots. source includes unpublished uploads. search applies when a current index exists and the media is ready; it does not require a succeeded source attempt. metadata uses the metadata owner's latest operation, oldest unfinished operation, unfinished count, retry policy, and personal review. absent means no applicable recorded obligation, not success.

needs attention takes precedence: an applicable source/search failure, latest metadata failure, or latest unreviewed no-findings result. otherwise applicable source/search activity or any unfinished metadata job makes the row active. otherwise it is complete. attention and progress counts are exclusive row counts. history includes all current states. a newer metadata result supersedes older attention; older unfinished jobs still block research and keep observation alive.

population includes existing upload/source imports and visible media with retained metadata jobs, including rss episodes without source attempts. published uploads retain the upload-first identity. metadata-only rows take their acceptance time from the earliest retained metadata job. no missing historical job is inferred or backfilled.

classify before filtering. attention considers only attention obligations; progress only active obligations. stage and failure code must match the same obligation. primary matching work is ordered by stage rank, failure/acceptance time, then obligation key. each row appears once; source, search, and metadata remain separately inspectable and actionable. source/search recovery uses separate resource capabilities and existing exact attempt/job/revision commands.

## reads

four authenticated repeatable-read routes return their models through `Data`: `/imports/summary` (`ImportSummary`), `/imports` (`ImportPage`), `/imports/{ref}` (`ImportDetail`) and `/imports/{ref}/history` (`HistoryPage`). snake-case json, tagged presence and always-sent fields; the web reads them as generated types (`lib/imports/api.ts`) and decodes nothing by hand. `ImportPage` owns its consistency checks (item count ≤ matched count, unique refs, grouped counts ≤ matched count, a continuing page is nonempty); `ImportDetail` owns issue-count equality.

a published upload keeps its `upload:<handle>` identity; the server owns the ref grammar. the url decoder admits a `?selected=` only as `upload:` or `media:` and one path segment (no `/`), so it cannot reach `/imports/summary` or another route; anything else is absent. a ref the server rejects (400 `E_INVALID_REQUEST`) or does not know (404 `E_IMPORT_NOT_FOUND`) reads "This import is no longer available".

every read is a pane-free `usePaneFreeServerValue` (`lib/api/serverState.ts`): it loads on its key, refetches when its `stale` string changes, keeps its data while it refetches, coalesces (one queued run, never aborting the one in flight), keeps a failed refetch's error beside the last good data, retries transport failures three times, sends 401 to the sign-in handler and throws defects in render.

## observation (`lib/imports/ImportsProvider.tsx`)

- the summary read's `stale` is a wake counter. a wake is `visibilitychange` to visible, `focus` after a `blur`, `pageshow`, `online`, the pane opening, an in-tab `Imports.Invalidated` event, an `Entries` change (architecture §8.12), and Refresh.
- the server stamps `observed_at` on every read; the newest successful summary's stamp is the only observation token. the list and the inspector put it in their `stale`, so they reread exactly when an observation lands.
- polling: every 5 s while the newest summary read succeeded, `unfinished_work_count > 0`, the document is visible, and the pane is open or a wake happened within the last 15 minutes. this count covers distinct unfinished source/index/metadata jobs across attempts and revisions, plus active uploads or applicable obligations without such a job. attention precedence and inapplicable older work cannot stop observation. a failed summary read stops polling until the next wake or Refresh.
- invalidation is in-tab only: other tabs catch up on their next wake or poll.
- metadata admission and personal review invalidate imports on success or replay, so an idle summary wakes. review refreshes metadata/action snapshots without a bibliography change event.
- upload commands (`dispatchUpload`) are pending per `handle|command`, so the row and the inspector both show "Starting…"; a duplicate in flight is ignored and a refusal is the caller's to report.

## lists

a view is the first `pages` server pages of its query (`lib/imports/query.ts` narrows it to what the view correlates, so `GET /imports` never answers 400). every observation rereads that prefix, so a refresh keeps the pages the reader loaded and a row removed anywhere in it disappears; Load more is one page longer (a reread of the whole prefix); a query change, including a return to an earlier one, starts again at one page (`usePagePrefix` in `lib/imports/api.ts`). a failed reread keeps the rows with "Couldn’t refresh imports · Showing the last update"; a failed Load more says "More imports couldn’t be loaded". the attempt history in the inspector is the same shape keyed by ref, rereading when the import's `updated_at` changes.

## history and review

stored upload/processing events keep their existing write grammar. `HistoryEntry.facts` additionally projects one metadata operation per retained job; no metadata events are invented. the metadata owner decodes each job with that job's latest generation in a batch. ids are namespaced text (`upload:`, `processing:`, `metadata:`), ordered by `(occurred_at desc, id desc)`. terminal metadata uses completion time; live metadata uses creation time. cursor bindings were cut over with this grammar; old cursors are rejected. the “recorded failures” filter includes metadata failures but excludes no-findings results.

mark reviewed records a personal acknowledgement of one exact no-findings job. any current reader may acknowledge it; only the creator can request research. older results remain reviewable, and reviewing them never clears newer attention. review decorates the existing history entry without changing its identity, time, or durable outcome. the shared mutation client retains its intent after an uncertain response. no generic failure dismissal or unreview exists.

item `updated_at` includes owner job updates and the viewer's review. a heartbeat may refresh live history, but never creates a history entry.

## url

`/imports?view&q&media_kind&stage&failure_code&state&had_failures&from&before&selected`, by wire name, in one canonical order. decoding is tolerant (unknown or invalid values are absent) and keeps what the reader wrote, including History-only filters while another view is open. dates are UTC days, `[from, before)`. the first entry without a view lands on Needs attention, else In progress, else History with `from` = today − 30 local days, once; later counts never move the reader.

## copy (`lib/imports/copy.ts`)

the owner of import, upload, and acquisition copy. `FAILURE_COPY` remains exhaustive over source/search `SafeFailureCode`; `lib/media/mediaMetadataCopy.ts` owns metadata status, safe reasons, and contextual action labels for imports and the metadata overlay. `IMPORT_FAILURE_CODES` combines their generated domains without a second metadata failure catalog. the inspector presents each obligation's own explanation and action. partial metadata success says “not established by this run”; readable/playable claims require readiness. older unfinished research is shown alongside the latest result.

## acquisition (`lib/imports/ingest.ts`)

`addMediaFromUrl`, `uploadIngestFile`, `retryUploadSession`, `removeUploadSession` and `captureSourceUrl`; see [add content](add-content.md) for the upload-session protocol. each endpoint's declared codes map to one `UploadSessionOutcome`; the outcomes that change what Imports owes invalidate it.

## vocabulary history

`E_BILLING_REQUIRED`, `E_LLM_BAD_REQUEST` and `E_PODCAST_QUOTA_EXCEEDED` left the catalog; migration `0272` rewrote every stored import failure that named one to `E_INGEST_FAILED` (media, source attempts, processing and upload events, baseline outcomes, and the queue rows imports reads). `media_transcript_states.last_error_code` keeps transcription's own reason.
