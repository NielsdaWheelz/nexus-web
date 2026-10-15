# imports

owner: `services/imports.py` composes and reads; source, search, and metadata owners supply their facts and recovery policies. `schemas/imports.py` and `schemas/import_history.py` own the output contracts; `schemas/import_refs.py` owns import identity. the web presents those facts through `apps/web/src/lib/imports/`.

## obligations

an import has independent `source`, `search`, and `metadata` nullable slots. source includes unpublished uploads. search applies when a current index exists and the media is ready; it does not require a succeeded source attempt. metadata uses the metadata owner's latest operation, oldest unfinished operation, unfinished count, retry policy, and personal review. null means no applicable recorded obligation, not success.

needs attention takes precedence: an applicable source/search failure, latest metadata failure, or latest unreviewed no-findings result. otherwise applicable source/search activity or any unfinished metadata job makes the row active. otherwise it is complete. attention and progress counts are exclusive row counts. history includes all current states. a newer metadata result supersedes older attention; older unfinished jobs still block research and keep observation alive.

metadata jobs retain their admitted `purpose`: native x uses `title`; other media uses `bibliography`. history never infers purpose from the current provider. a completed title may use its source label; this is successful abstention, without no-findings or review. naming failure leaves readable source intact. [media metadata](media-metadata.md) owns the generation and outcome contracts.

population includes existing upload/source imports and visible media with retained metadata jobs, including rss episodes without source attempts. published uploads retain the upload-first identity. metadata-only rows take their acceptance time from the earliest retained metadata job. no missing historical job is inferred or backfilled.

each item carries readiness hydrated from current media capabilities, independently of obligation completion. before publication all readiness is false. published upload titles use the current media title; their immutable `original_filename` remains present and searchable. media-only rows have absent filenames. an active unpublished upload says `AwaitingUploadConfirmation`, with no measured transfer progress; recorded failure and expiry take precedence.

document readability requires the reader-publication owner's shared eligible-kind, persisted-ready and existing-publication predicate; pdf also requires its original file. media hydration and the quote projection share that predicate. an uploaded original alone remains downloadable, without a read promise. retained x publications remain readable while source recovery proceeds independently.

classify before filtering. attention considers only attention obligations; progress only active obligations. stage and failure code must match the same obligation. primary matching work is ordered by stage rank, failure/acceptance time, then obligation key. each row appears once; source, search, and metadata remain separately inspectable and actionable. source and search recovery are separate actions of the media (one `Recovery` each), sent with the exact attempt/job/revision the reader saw; the row, the inspector and the menu share one busy key per recovery.

## reads

four authenticated repeatable-read routes return their models through `Data`: `/imports/summary` (`ImportSummary`), `/imports` (`ImportPage`), `/imports/{ref}` (`ImportDetail`) and `/imports/{ref}/history` (`HistoryPage`). snake-case json, plain nullable and always-sent fields; the web reads them as generated types (`lib/imports/api.ts`) and decodes nothing by hand. `ImportPage` owns its consistency checks (item count ≤ matched count, unique refs, a continuing page is nonempty); `ImportDetail` owns issue-count equality. pages contain flat server-ordered items, without stage groups or stage totals.

a published upload keeps its `upload:<session id>` identity; the server owns the ref grammar. the url decoder admits a `?selected=` only as `upload:` or `media:` and one path segment (no `/`), so it cannot reach `/imports/summary` or another route; anything else is absent. a ref the server rejects (400 `E_INVALID_REQUEST`) or does not know (404 `E_IMPORT_NOT_FOUND`) reads "This import is no longer available".

every read is a pane-free `usePaneFreeServerValue` (`lib/api/serverState.tsx`): it loads on its key, refetches when its `stale` string changes, keeps its data while it refetches, coalesces (one queued run, never aborting the one in flight), keeps a failed refetch's error beside the last good data, retries transport failures three times, sends 401 to the sign-in handler and throws defects in render.

## observation (`lib/imports/ImportsProvider.tsx`)

- the summary read's `stale` is a wake counter. a wake is `visibilitychange` to visible, `focus` after a `blur`, `pageshow`, `online`, the pane opening, an in-tab `Imports.Invalidated` event, an `Entries` change (architecture §8.12), and Refresh.
- the server stamps `observed_at` on every read; the newest successful summary's stamp is the only observation token. the list, inspector and mounted history put it in their `stale`, so they reread when an observation lands. collapsing history retains its loaded prefix; there is no history poller.
- polling: every 5 s while the newest summary read succeeded, `unfinished_work_count > 0`, the document is visible, and the pane is open or a wake happened within the last 15 minutes. this count covers distinct unfinished source/index/metadata jobs across attempts and revisions, plus active uploads or applicable obligations without such a job. attention precedence and inapplicable older work cannot stop observation. a failed summary read stops polling until the next wake or Refresh.
- invalidation is in-tab only: other tabs catch up on their next wake or poll.
- metadata admission and personal review invalidate imports on success or replay, so an idle summary wakes. review reconnects the media's metadata observer without a bibliography change event.
- upload commands (`dispatchUpload`) are pending per `session id|command`, so the row and the inspector both show "Starting…"; a duplicate in flight is ignored and a refusal is the caller's to report.

## lists

a view is the first `pages` server pages of its query (`lib/imports/query.ts` narrows it to what the view correlates, so `GET /imports` never answers 400). every observation rereads that prefix, so a refresh keeps the pages the reader loaded and a row removed anywhere in it disappears; Load more is one page longer (a reread of the whole prefix); a query change, including a return to an earlier one, starts again at one page (`usePagePrefix` in `lib/api/pagePrefix.ts`). a failed reread keeps rows with a stale notice and retry; a failed continuation keeps the prefix with its own retry. detail and history use the same retained-facts rule. a genuinely unavailable ref replaces retained actionable details with the gone notice.

modes live in shell navigation; draft/submit/clear/reset and filters use `PaneQueryToolbar` in the shell query slot. one flat resource list presents a consequence, contextual facts and actions per row. readiness gates visible open; the item's current activation, read when open is pressed (`resolveResourceItem`), authorizes it. desktop `Adopt` reuses a matching reader or creates beside imports; mobile `Follow` uses the existing back path. pane limits remain the workspace planner's responsibility.

title activation selects details and supplies its actual trigger. selection restoration alone never opens a dismissed companion; explicit row/header/add activation does. closing retains selection and returns focus through the shell. recovery of a disappearing list control locally returns to the same row title, following row title, then query, only while focus is lost and this pane is active; explicit focus elsewhere wins.
a refused upload restores its surviving enabled trigger under those same focus and active-pane guards.
foreign focus retires list ownership immediately, even if it returns to body before the next commit. busy inline source/search recovery uses focusable `aria-disabled` controls with guarded activation; unavailable actions retain native disabling.

## history and review

stored upload/processing events keep their existing write grammar. `HistoryEntry.facts` additionally projects one metadata operation per retained job; no metadata events are invented. the metadata owner decodes each job with that job's latest generation in a batch. ids are namespaced text (`upload:`, `processing:`, `metadata:`), ordered by `(occurred_at desc, id desc)`. terminal metadata uses completion time; live metadata uses creation time. cursor bindings were cut over with this grammar; old cursors are rejected. the “recorded failures” filter includes metadata failures but excludes no-findings results.

mark reviewed records a personal acknowledgement of one exact no-findings job. any current reader may acknowledge it; only the creator can request research. older results remain reviewable, and reviewing them never clears newer attention. review decorates the existing history entry without changing its identity, time, or durable outcome. each attempt sends a fresh mutation id; a repeat after an uncertain response gets the review already recorded. no generic failure dismissal or unreview exists.

item `updated_at` includes owner job updates and the viewer's review. a heartbeat may refresh live history, but never creates a history entry.

history starts collapsed unless the row matches a past event. match evidence belongs to the exact ref and applied api query; it never survives either changing. a new match expands once, and a user's collapse persists for that same match across observations. current obligations remain separate from matched historical failure. partial coverage remains explicit; loaded events survive failed continuation and retry.

## url

`/imports?view&q&media_kind&stage&failure_code&state&had_failures&from&before&selected`, by wire name, in one canonical order. decoding is tolerant (unknown or invalid values are absent) and keeps what the reader wrote, including History-only filters while another view is open. dates are UTC days, `[from, before)`. the first entry without a view lands on Needs attention, else In progress, else History with `from` = today − 30 local days, once; later counts never move the reader.

## copy (`lib/imports/copy.ts`)

the owner of import, upload, and acquisition copy. `FAILURE_COPY` remains exhaustive over source/search `SafeFailureCode`; `lib/media/mediaMetadataCopy.ts` owns metadata status, safe reasons, and contextual action labels for imports and the metadata overlay. `IMPORT_FAILURE_CODES` combines their generated domains without a second metadata failure catalog. the inspector presents each obligation's own explanation and action. partial metadata success says “not established by this run”; readable/playable claims require readiness. older unfinished research is shown alongside the latest result.

## acquisition (`lib/imports/ingest.ts`)

`addMediaFromUrl`, `uploadIngestFile` and `removeUploadSession`; see [ingest](ingest.md) for the upload-session protocol. each endpoint's declared codes map to one `UploadSessionOutcome`; the outcomes that change what Imports owes invalidate it. create/publication receipts carry producer-owned exact refs. Retry upload keeps basic file validation and sends the chosen file as `uploadIngestFile({file, libraryIds: [], id: <session id>})`: the server owns normalized filename, content type and size admission (another intent is 409 `E_UPLOAD_INTENT_MISMATCH` before any byte), and the session advances (or answers what it published) under its first destinations; `Superseded` counts as done. an `UploadFailed` history row is narrated from its envelope code.

## native x sources

`services/x_client.py` acquires the requested post or same-author thread plus one
hop of direct quotes, reply parents and repost targets. `schemas/x_source.py` owns
normalized evidence; `services/x_source.py` owns its current persisted snapshot,
coverage and excerpt. retain full authored wording, url observations, supplied image
descriptions and attributed context. nested references never trigger another fetch.
author-thread searches explicitly begin at the provider's archive floor,
`2006-03-21T00:00:00Z`, on every page; omitting this bound restricts results to
the last 30 days. the existing post budget still limits acquisition.
`post_limit` means enumeration stopped at the configured bound; `exhausted` means
enumeration ended, not that every historical post remains available.

`services/x_ingest.py` prepares source and reader content before publication. the
source coordinator's exact claim and ordered media locks fence one transaction that
installs reader content, snapshot and excerpt, settles the attempt, and admits indexing
and naming. a newly completed quoted child receives its own snapshot and naming job.
a child with a reader publication retains its independent source, including an ongoing
refresh. identity reuse transfers access and supersedes onto the existing holder;
it installs no new evidence or naming obligation.

reader content and naming consume the same evidence. quotes retain their existing
embeds; external reply/repost context follows the primary content, and references to
other primary posts do not repeat them. the reader retains attachment links to
preserve source wording and saved positions. standalone posts keep their generic
quote footer when enhanced with embeds; threads keep their attributed footer.
the immediate title is the first
nonempty authored opening, shortened at a unicode word boundary within 120 code
points without splitting a grapheme. when that would retain only an opening mention
or hashtag, keep the grapheme prefix. quote/attachment tokens are removed from title
evidence; meaningful links remain. textless evidence uses
`x post by @handle` or `x thread by @handle`. generated titles belong to the existing
metadata job, independently of source readiness.

## source refresh

`POST /media/{id}/refresh` requires `expected_attempt_id`; its 202 response is a
`SourceAdmission` with media, attempt and job ids. `services/media_source_ingest.py`
admits retry and refresh through one successor step while keeping their policies
distinct ([ingest](ingest.md)). authorization, the exact latest attempt and source
policy precede mutation; the new attempt and its job commit together. a resend of
the same expectation answers the successor that landed; a fresh stale expectation
conflicts. browser retries resend the original expectation.

native x retains its readable publication while refresh is queued, running, failed
or stopped. first imports keep ordinary failure behavior. authorized refresh first
initializes any ready legacy copy's missing reader publication through its existing
owner; it never reconstructs normalized evidence from rendered fragments. a failed
refresh remains visible on its source attempt and supports ordinary retry or exact
dead-job repair while the saved copy remains readable.

replacement composes the [reader's position owner](reader-implementation.md): every
saved position must map exactly into the replacement before fragments are deleted.
`E_SOURCE_POSITION_UNMAPPABLE` rolls back source, snapshot and naming admission and
keeps the saved copy. retry alone may repeat the refusal; deliberate repositioning
or a changed source can resolve it. title-only changes preserve content identity.

## x source cutover

`python -m nexus.ops.refresh_x_sources plan --manifest <path>` freezes existing
native-x media, creators and expected attempts before admission and previews
refusals. run after the release backup, writer stop and migration preflight.
`apply` uses ordinary refresh admission; rerun it to recover lost responses (the
same expected attempt answers its landed successor) and observe source/title
settlement. it neither runs workers nor bypasses exact-job repair.

receipts survive replacement of current snapshots. retained jobs after the database's
frozen timestamp account for each target's first title obligation and inline children,
including children completed before their own planned refresh. a frozen child may be
counted as refreshed only when its current successful publication records this
manifest's exact admitted parent attempt; retain the real child attempt and job
receipts without inventing an admission or changing the frozen request. ordinary
refresh clones do not inherit inline publication provenance. new children add naming
obligations, never refresh targets. `release_accounted` requires zero unfinished and
unaccounted work; recorded unavailable copies, source refusals and title failures remain
explicit exceptions requiring follow-up. retain the manifest with release evidence.

## vocabulary history

`E_BILLING_REQUIRED`, `E_LLM_BAD_REQUEST` and `E_PODCAST_QUOTA_EXCEEDED` left the catalog; migration `0272` rewrote every stored import failure that named one to `E_INGEST_FAILED` (media, source attempts, processing and upload events, baseline outcomes, and the queue rows imports reads). `media_transcript_states.last_error_code` keeps transcription's own reason.
