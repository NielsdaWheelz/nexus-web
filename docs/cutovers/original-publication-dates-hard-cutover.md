# original publication dates: hard cutover

approved scope: original/edition dates, better research, ingestion fixes, and app-wide date usage. this is the implementation contract; it supersedes the broader [council research](media-metadata-council-review.md). no product question remains open. the [module guide](../modules/media-metadata.md) owns implemented behavior and maintenance commands.

**target behavior.** the app locates the work in publication history; media info also identifies the encountered edition. a penguin heart of darkness displays **1899** in lists/search and its actual penguin publication date in media info. serialization counts. first book appearance in 1902 needs no third field.

original means first public publication of the identified work. translations/revisions retain the original work date; a collection uses its own date, never its oldest component. a linked preprint may establish a paper's earlier public release; similar titles alone do not establish identity. an edition date means the encountered edition/version's publication. composition, file creation, scanning, fetching, and modification are neither date. determine content identity from content, not file extension.

**data and api contract.**

| owner | final shape |
| --- | --- |
| `media` | `original_published_date text null`, `edition_published_date text null`, `edition_isbn text null`; remove `published_date` |
| generated metadata | replace `published_date` with both new date fields, each required and nullable; retain all other output fields |
| existing `MediaOut` (detail and `/media` list) | both dates as required `Presence<PublicationDate>`; retain the shared response type |
| compact library media row, search source, podcast episode media response | `original_published_date: Presence<PublicationDate>`; omit edition information from these compact projections |
| metadata job payload | required `media_id`, `requester_user_id`, existing `request_id`; deduplication stays an enqueue argument |
| existing retry api | keep `POST /media/{id}/retry`, body `{"from_stage":"metadata"}`; authenticated viewer supplies the internal requester |

metadata eligibility is shared by worker, backfill, retry, and capability projection: readable media, or pending video/podcast episodes. retry retains creator authorization and unresolved-turn checks. there is no new public mutation endpoint. remove the old media date key from producers and strict client decoders; accept only the new shape. generic row `publicationDate` and “published” sort identifiers can retain their names: their media value is always the original date. unrelated podcast-container/provider timestamps retain their existing contracts.

`PublicationDate` here is a real `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`, years 1–9999. external source instants become their utc calendar date; never pad partial dates. bibliographic sub-day precision is deliberately discarded; exact operational timestamps remain separate. add one small backend calendar-date validator and a date-only decoder in the existing browser `lib/dates/publicationDate.ts`, reusing its calendar checks; retain its instant decoder for operational callers. unsupported source dates are absent without failing ingestion; an invalid generated date rejects the generated payload. database null and model-output null convert at their boundaries to owned presence values. no new database business constraints.

a valid generation replaces **both** dates, including clearing them with null. unchanged nulls are still a successful date resolution, not “no applicable fields.” failed, malformed, stale, or uncertain generations change neither date. keep other metadata merge behavior, including manual-author protection. accept that an inconclusive successful rerun can clear a previous guess.

**ingestion and prompt.** source adapters write publication observations only to `edition_published_date`; enrichment owns `original_published_date`. an ordinary article/episode can end with identical dates, but ingestion does not assume that equality. a valid source observation replaces the edition date; an absent/invalid observation leaves its existing value. source refresh never writes the original date. only successful generated null clears dates. new imports can temporarily lack their primary date.

- epub: reuse the opf parser; retain `dc:date` as edition publication, preferring explicit `opf:event="publication"` over unqualified dates, ignoring other explicit events, and leaving differing selected dates absent. retain a recognized isbn as `edition_isbn`. normalize valid isbn-10/13 to isbn-13; prefer the package's declared primary identifier when it is an isbn, otherwise retain the sole unambiguous isbn. do not store package uuids or build a generic identifier registry.
- pdf: delete publication-date assignment from file creation. remove `pdf_creation_date` from extraction results and its parser if no other production consumer remains.
- article, browser capture, email, video, and podcast adapters: map actual source publication to edition date using the common ingress validator. retain operational provider timestamps separately.
- prompt: distinguish original and edition hints, include the isbn, keep the title/creator/source context, and replace the tool prohibition with targeted research instructions. identify the work first; inspect relevant local passages or web sources when needed; return unknown dates as null. never choose a date merely because it is the oldest number found.

publisher and language keep their current encountered-source meanings. no new original-language, translator, revision, work-identity, event-history, or provenance schema.

**capability contract and composition.** one metadata generation uses the existing job, shared agent kernel, strict structured output, and publication transaction.

```text
source publication → enqueue with requester → freeze input/scope/policy
→ one metadata generation with scoped reads → validate output
→ recheck admitted source → atomically replace dates and invalidate projections
```

add one `MetadataRead` plan granting exactly `web.search`, `web.read`, `nexus.document.search`, and `nexus.resource.read`. freeze `FrozenToolScope(admitted_refs=("media:<id>",), predicates=())`; reuse existing parent-media admission for passage/page pointers and existing read authorization.

thread the exact successful source attempt's `created_by_user_id`, podcast sync's `viewer_id`, or retry viewer into the job as `requester_user_id`. ownerless maintenance work must supply an explicit authorized viewer. do not invent a system principal or select an arbitrary account; source work without a requester does not enqueue this optional research.

bind the pinned `llm-tools` reader through `web_family`. extend declarations, reviewed profiles/authority, and both execution/projection compositions. use the existing generation binding constructors demonstrated in `artifacts/generation_step.py`; keep the default no-domain-projection path. normal runtime receipts remain; add no metadata citations, evidence tables, or confidence states.

the exact plan requires the existing brave search configuration. unavailable bindings fail admission; there is no silent local-only research mode.

reuse the current background model selection. initial frozen limits: eight tool calls, 64 external attempts, 256 kib tool-input budget, 4 mib serialized tool-output budget, one in-flight call, 120 seconds aggregate tool time, 300 seconds generation timeout. retain tool-specific limits. these bound tool traffic; the recorded background context-token budget is not currently enforced by nexus. rely on the native runtime's context limit and existing failure path; fixing the general [budget enforcement gap](../tickets/background-generation-context-budget-is-not-enforced.md) is separate work. these are operating bounds, not an accuracy promise; existing budget/capacity/failure handling applies. never add a hidden continuation run, model fallback, or second orchestrator.

web read supports public html/text/json through the existing bounded reader; no browser automation, authentication, remote-pdf reader, or vision extension. local search/read uses existing extracted content. source text stays untrusted. authority rejects foreign nexus resources and library writes. instruct the model to send only needed identifying strings in external requests; query-content confidentiality is model behavior, not a guarantee supplied by scope checks.

preserve admitted-input checks, worker claims, atomic publication/replay, uncertain-dispatch handling, title publication ownership, and collection invalidation. freeze/recheck `reader_publications.generation` and the media's `content_index_states.revision/status/updated_at` with the input. the timestamp also detects same-revision transcript reindexing. reuse `read_publication_generation` and `lock_publication_generation` after the media lock; compare before applying a title change. absent publications/indexes are valid for pending or non-document media. do not introduce a revision counter or require document readiness for every media kind.

**app usage and media info.** media list/search labels, library ordering, contributor chronology, retrieval context, and media-publication recency read the original date directly. unknown originals sort last and display as unknown/omitted under existing formatting; **no edition fallback**. media recency uses real day-precision original publication dates only; partial dates never manufacture recency.

keep acquisition time, reading activity, feed watermarks, and episode scheduling/release ordering on their existing operational timestamps. a media-date migration must not rewrite those facts.

the existing `ResourceCreditsOverlay` has one production consumer. evolve it into `MediaInfoOverlay`, move it under media components, and replace the reader's “credits…” action with “media info…”. reuse its dialog/mobile-sheet and focus lifecycle. retain credits; add read-only “first published,” “this edition,” and publisher rows. show unknown dates explicitly. no new inspector tab, metadata editor, evidence UI, toolbar, or permanent reader header. reuse the collection date formatter rather than copy date rendering.

**hard cutover.** enter maintenance: stop new admission, drain/reconcile relevant source/podcast/metadata work, then stop old api and worker readers/writers before migration. unresolved accepted metadata execution blocks the cutover. do not decode old generated payloads with a compatibility branch.

add the new columns empty and drop `media.published_date`. do not copy mixed legacy values into either date. keep historical migration files and opaque completed execution history; remove executable old-field readers/writers. deploy api, worker, and web together; refresh stale clients and advance affected collection revisions so old cursor projections cannot be reused.

provide one maintenance command, `backfill_media_publication_dates --viewer-id <uuid>`, using existing queue admission and per-media dedupe. process authorized readable media in bounded batches. for existing epubs, reuse opf-only extraction from their stored source to populate edition/isbn hints; do not rebuild content, search indexes, annotations, or reader packages. enqueue one research job per selected media. normal ingestion handles unfinished imports. report queued/skipped/failed counts through ordinary command/job output; no new dashboard or durable backfill framework.

temporary empty dates and loss of unsupported legacy guesses are intentional. retain the normal pre-cutover database backup for rollback; no legacy column, runtime switch, dual write, or fallback stays in the final system.

**implementation boundaries.** agree the table/schema and enqueue signature first; each file has one owner. b supplies the enqueue contract; a updates source/podcast callers. c consumes a's date contract. d starts after a–c integrate.

backend paths below are relative to `python/nexus/`; bare service filenames are under `services/`.

| work | owned files / responsibilities |
| --- | --- |
| a — dates, ingestion, enrichment semantics | `python/nexus/db/models.py`; new `schemas/publication_dates.py`; `services/metadata_enrichment.py`; `epub_ingest.py`, `epub_metadata.py`, `pdf_ingest.py`, `pdf_metadata.py`; publication writers in `web_article_ingest.py`, `media_source_ingest.py`, `email_ingest_service.py`, `youtube_video_ingest.py`, `podcasts/ingest.py`. includes source enqueue callers and source-metadata extraction reuse. |
| b — capability and job execution | `services/tool_runtime/{composition,declarations,profiles,authority}.py`; `generation_policy.py`; `tasks/enrich_metadata.py`; `metadata_dispatch.py`, `metadata_lifecycle.py`. reuse generation/tool constructors; edit other closed policy maps only where this new plan requires it. |
| c — projections and presentation | `schemas/{media,library,search,podcast}.py`; `services/media.py`, `library_entries.py`, `contributor_credits.py`, `podcasts/episodes.py`, `search/`, `resonance/`; web media/library/search/podcast decoders and presenters; existing date/collection formatting; `MediaPaneBody.tsx`, renamed media-info component/styles. remove old media field from internal candidate payloads too. |
| d — cutover and focused proof | one new alembic migration; one maintenance command under `python/scripts/`; affected existing service/kernel/browser proof and fixtures; module docs. implement column/cursor cutover from a/c contracts. no benchmark project. |

use `rg 'published_date|publishedDate' python/nexus apps/web/src` to close the producer/consumer inventory. classify each hit as media bibliography or a separate operational/provider fact; do not blindly rename every timestamp. avoid unrelated refactors. delete the old metadata date prompt/schema/merge path, dead pdf-date extraction, and superseded credits component imports instead of retaining aliases.

**acceptance.**

1. a modern heart of darkness fixture resolves to original 1899 and its actual edition date; changing only the reprint year cannot change the original. include a collection and a same-title/different-author case in focused checks.
2. epub isbn/date reach the prompt with their edition meanings; a uuid is not an isbn; pdf creation never populates either publication date.
3. partial calendar dates retain precision; valid source instants convert to utc days. invalid source dates are ignored without failing ingestion; invalid generated dates reject the payload. source refresh obeys replacement rules; generated null clears; generation failure/staleness leaves dates untouched.
4. the plan exposes exactly four usable reads; a scoped tool round trip works; foreign-resource access and writes are denied by authority. smoke-check untrusted instructions and external query contents as model behavior. completed-tool replay does not redispatch.
5. media info shows both dates; library/search/author chronology agree on the original; unknown originals do not borrow edition dates. media info works through the existing dialog/sheet keyboard and focus behavior.
6. migration plus batched backfill completes with no old media date path, no old-output decoder, and no changes to source identity, highlights, progress, or operational timestamps.

run affected checks only through `./scripts/test changed <paths>` and the repository-required gates at implementation time. use controlled provider results for deterministic regression proof and inspect a few real imports as smoke verification. no semantic benchmark corpus, model bake-off, scoring dashboard, or accuracy claim is required.

**non-goals and review rule.** no work graph, event taxonomy, first-book field, stored field evidence, correction/pinning system, new model selection, historical-date engine, research swarm, or background curator. at each boundary review ask: does an edition value leak into original chronology; does a read gain unnecessary authority; does a new abstraction duplicate an existing primitive; does migration preserve an ambiguous legacy path? reject the implementation if any answer is yes.

the [earlier research](media-metadata-council-review.md) remains rationale only. its proposed citation subsystem, metadata editor, and benchmarking program were rejected; they are not deferred implementation requirements.
