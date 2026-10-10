# imports

status: reauthored (cleanup/imports-reauthor); live harness `campaign-artifacts/2026-10-09/imports/harness`.
owner: `services/imports.py` classifies and reads; `schemas/imports.py` and `schemas/import_history.py` own the output contracts and the failure vocabulary; the web presents those facts through four modules under `apps/web/src/lib/imports/`.

## reads

four authenticated repeatable-read routes return their models through `Data`: `/imports/summary` (`ImportSummary`), `/imports` (`ImportPage`), `/imports/{ref}` (`ImportDetail`) and `/imports/{ref}/history` (`HistoryPage`). snake-case json, tagged presence and always-sent fields; the web reads them as generated types (`lib/imports/api.ts`) and decodes nothing by hand. `ImportPage` owns its consistency checks (item count ≤ matched count, unique refs, grouped counts ≤ matched count, a continuing page is nonempty); `ImportDetail` owns issue-count equality.

a published upload keeps its `upload:<handle>` identity; the server owns the ref grammar. the url decoder admits a `?selected=` only as `upload:` or `media:` and one path segment (no `/`), so it cannot reach `/imports/summary` or another route; anything else is absent. a ref the server rejects (400 `E_INVALID_REQUEST`) or does not know (404 `E_IMPORT_NOT_FOUND`) reads "This import is no longer available".

every read is a pane-free `usePaneFreeServerValue` (`lib/api/serverState.ts`): it loads on its key, refetches when its `stale` string changes, keeps its data while it refetches, coalesces (one queued run, never aborting the one in flight), keeps a failed refetch's error beside the last good data, retries transport failures three times, sends 401 to the sign-in handler and throws defects in render.

## observation (`lib/imports/ImportsProvider.tsx`)

- the summary read's `stale` is a wake counter. a wake is `visibilitychange` to visible, `focus` after a `blur`, `pageshow`, `online`, the pane opening, an in-tab `Imports.Invalidated` event, a library placement revision whose libraries became unknown, and Refresh.
- the server stamps `observed_at` on every read; the newest successful summary's stamp is the only observation token. the list and the inspector put it in their `stale`, so they reread exactly when an observation lands.
- polling: every 5 s while the newest summary read succeeded, `active_count > 0`, the document is visible, and the pane is open or a wake happened within the last 15 minutes. a failed summary read stops polling until the next wake or Refresh; the stale notice and Try again show.
- invalidation is in-tab only: other tabs catch up on their next wake or poll.
- upload commands (`dispatchUpload`) are pending per `handle|command`, so the row and the inspector both show "Starting…"; a duplicate in flight is ignored and a refusal is the caller's to report.

## lists

a view is the first `pages` server pages of its query (`lib/imports/query.ts` narrows it to what the view correlates, so `GET /imports` never answers 400). every observation rereads that prefix, so a refresh keeps the pages the reader loaded and a row removed anywhere in it disappears; Load more is one page longer (a reread of the whole prefix); a query change, including a return to an earlier one, starts again at one page (`usePagePrefix` in `lib/imports/api.ts`). a failed reread keeps the rows with "Couldn’t refresh imports · Showing the last update"; a failed Load more says "More imports couldn’t be loaded". the attempt history in the inspector is the same shape keyed by ref, rereading when the import's `updated_at` changes.

## url

`/imports?view&q&media_kind&stage&failure_code&state&had_failures&from&before&selected`, by wire name, in one canonical order. decoding is tolerant (unknown or invalid values are absent) and keeps what the reader wrote, including History-only filters while another view is open. dates are UTC days, `[from, before)`. the first entry without a view lands on Needs attention, else In progress, else History with `from` = today − 30 local days, once; later counts never move the reader.

## copy (`lib/imports/copy.ts`)

the one owner of every string a reader sees about an import, an upload or an acquisition. `FAILURE_COPY` is exhaustive over the generated `SafeFailureCode` and is also the runtime vocabulary (`isSafeFailureCode`, `SAFE_FAILURE_CODES`); its `recovery` fact is `SameSource`, `OpenOriginal` or absent, never `SameSource` for a same-source terminal code. beside it: stage copy, the state pill (`stateBadge`: one label and tone for row and inspector), the recovery sentence, history narration, dates, counts, notices, and the per-surface outcome tables for Imports commands, capture and attachments, and Add acceptance. `lib/media/mediaErrorMessage.ts` presents media failures from the same catalog.

## acquisition (`lib/imports/ingest.ts`)

`addMediaFromUrl`, `uploadIngestFile`, `retryUploadSession`, `removeUploadSession` and `captureSourceUrl`; see [add content](add-content.md) for the upload-session protocol. each endpoint's declared codes map to one `UploadSessionOutcome`; the outcomes that change what Imports owes invalidate it.

## vocabulary history

`E_BILLING_REQUIRED`, `E_LLM_BAD_REQUEST` and `E_PODCAST_QUOTA_EXCEEDED` left the catalog; migration `0272` rewrote every stored import failure that named one to `E_INGEST_FAILED` (media, source attempts, processing and upload events, baseline outcomes, and the queue rows imports reads). `media_transcript_states.last_error_code` keeps transcription's own reason.
