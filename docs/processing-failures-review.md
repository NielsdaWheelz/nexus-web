# processing failures: diagnosis and repair direction

2026-09-26. three independent reviewers covered pipeline/recovery, document
parsing, and product/standards research. the primary investigation inspected
production and reconciled their findings. the council below represents expert
perspectives, not consultations with named people.

## scope and evidence

production api, workers and release pointer identify
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`; database revision is `0241`.
local review began at `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`.
audited ingestion, apparatus, recovery and index source files match the deployed
revision. unrelated local changes were preserved.

the current imports owner's actual sql, with this viewer's visibility rules,
returns **24 needs-attention, 505 complete, zero active**. production reads began
2026-09-27 00:32 utc (september 26 locally). the 24 comprise 22 failed source
imports and two readable articles with dead current index jobs. a whole-database
query also found three superseded oracle seed failures outside the visible
imports list and two historical note-index failures.

database inspection used read-only transactions. all seven retained failed
uploaded epubs were downloaded through existing signed reads; their sizes and
sha256 values matched `media_file`. source fetching used the deployed node
ingress leaf without invoking publication. parser probes stopped immediately
before the first asset-storage/database publication. one x post lookup checked
provider availability; it did not run the thread import. no production retries,
queue changes, publication, deletion, restart, release or application-code edit
occurred. repository changes are this report, tickets and register entries.

private receipts and diagnostic scripts live in
`/tmp/nexus-processing-review-20260926/`. no source books, credentials, signed
urls, gift-link tokens or complete article bodies are copied into this report.

## every visible failure

ids below are unique media-id prefixes; full ids are retained in the private
inventory and relevant tickets. repeated titles are separate existing records.

| # | item / id prefix | diagnosed cause and evidence | proper recovery |
|---|---|---|---|
| 1 | portrait of the artist, norton / `9e5d8118` | repeated apparatus ancestor scans exhaust 30 s; reproduced on exact bytes; old row calls this unsafe archive | fix shared apparatus cost; deliberately reprocess retained source |
| 2 | pierre / `13c1fae1` | three missing toc anchors; a fourth contents destination points outside the spine. the current parser reaches publication with four unresolved navigation issues | permit diagnosed reprocessing; disclose each unavailable destination |
| 3 | this living hand / `16b411ce` | old stored publication lacks one required heading id; index assertion fails | normalize stored publication in place, preserve fragment/text/cursor, request fresh index revision |
| 4 | letters of keats to fanny brawne / `51c2b8a8` | same omitted old-data normalization, 56 headings | same; preserve positioned cursor at text offset 52 |
| 5 | allpoetry, durin / `e780199c` | deployed ingress currently returns 403 | browser capture if user can read it, or another legitimate source |
| 6 | reddit, meat fridges / `e4f2156a` | deployed ingress currently returns 403 | browser capture |
| 7 | tolkien gateway, world was young / `ac1b2e1a` | deployed ingress currently returns 403; a separate plain-http client got 404 | locate the accessible/correct source before capturing; inspect duplicate filing |
| 8 | same tolkien gateway url / `6f449edc` | distinct saved record, same result | same; no silent duplicate deletion |
| 9 | gutenberg ebook 38145 / `08d23b86` | saved as web article; actual url serves epub zip; deployed article ingress rejects media type | explicit source correction/replacement through epub owner, preserving filing |
| 10 | nyt, ai agents/jobs, june 30 / `a15eb5b8` | deployed ingress currently returns 403 despite saved gift link | capture from an accessible browser session |
| 11 | nyt, world order, september 1 / `ec7f1f38` | deployed ingress currently returns 403 | same |
| 12 | quora, venkatesh rao on writing / `fc6bc7de` | deployed ingress currently returns 403 | browser capture |
| 13 | atlantic, the simple art of murder / `09dba255` | deployed ingress currently returns 403 | browser capture |
| 14 | paris review, robert fitzgerald / `7c98d875` | deployed ingress currently returns 403 | browser capture; alternate-client 200 is not full-content proof |
| 15 | paris review, robert fagles / `0f9b6b1e` | deployed ingress currently returns 403 | same |
| 16 | paris review, annie dillard / `ff2e9dc0` | deployed ingress currently returns 403 | same |
| 17 | wsj, `SB10001424052748704576204574529703577274572` / `336cf7c4` | deployed ingress currently returns 401 | authenticated browser capture |
| 18 | emily wilson / nolan's odyssey video / `030d5aa5` | historical transcript-unavailable outcome predates current playback-only source contract | ordinary source retry; transcription remains separate and unverified |
| 19 | x post `2064762580317397366` / `5fb0a954` | june credit exhaustion; current authenticated lookup returns 200 with post | ordinary author-thread retry; full thread-search permission/completion still unverified |
| 20 | fanged noumena / `abf268f5` | historical embedding bad request; exact current parser reaches publication boundary in 2.16 s | ordinary source retry; verify readable publication and derived indexing separately |
| 21 | odyssey, fitzgerald / `c7f9c508` | genuinely missing cover-chapter image; separate declared cover exists | preserve available book/cover, disclose broken resource, reprocess after policy fix |
| 22 | persuasion / `a9ddec14` | same damaged cover-chapter reference | same |
| 23 | sense and sensibility / `9378ff1b` | same damaged cover-chapter reference | same |
| 24 | toll the hounds / `aa4dee6d` | 20 referenced images absent; valid declared cover exists; some missing images may contain initial letters | prefer complete replacement source; partial rendition must disclose omissions and locations |

the twelve access failures were probed individually through the actual deployed
node ingress: eleven 403 responses and one 401. this establishes the current
acquisition result, not the site's precise blocking policy. plain urllib reads
from the same host obtained 200 for the three paris review pages and 404 for
tolkien gateway. client-dependent responses make a blanket claim of permanent
unavailability unjustified. full paris review content and browser capture were
not verified. introducing client impersonation or a scraper cascade is not
supported by this evidence.

## the causes that warrant changes

**apparatus analysis has avoidable repeated work.**
`services/html_apparatus.py:542` computes an entire normalized ancestor string,
lowercases it, then retains 80 characters. joyce's 1,405,248-character book
caused 1,611,400,478 normalized characters to be rebuilt. `_target_context` consumed
32.95 s of a 33.54 s profile. the same exact bytes failed current parsing at
33.67 s under the unchanged 30 s budget.

a scratch-only experiment retained the exact normalized prefixes for one
parsed tree at a time: 0.85 s, about 40 times faster, with essentially unchanged
peak rss (~148 mb). all ordered target records, apparatus html/items/edges,
sanitized chapter html and canonical text had the same hash:
`46f40b33c8adadbeab5e66cdb94177f1369f08ee319fd3eb732d82d4e867f00f`.
only 693 misses, 19,204 hits, maximum 11 entries per parsed tree. implement this
inside the shared owner with explicit invocation lifetime. preserve existing
unicode semantics. production cpu/memory-envelope acceptance remains required.
[ticket](tickets/epub-apparatus-prefix-scans-exhaust-parse-budget.md).

**recovery policy mistakes an old failure for permanent impossibility.**
`services/capabilities.py:53-63` and
`services/media_source_ingest.py:245-255` gate retry by old error code. ten of
the 25 database source failures permit ordinary retry; fifteen are blocked,
including the three obsolete oracle rows. current code can parse pierre, but
normal recovery refuses it. an explicit owner-controlled reprocess admission
must accept a diagnosed change in processing conditions while checking the
exact prior attempt and retained source identity. it must keep all current
validators and preserve history. no automatic infinite retry, historical-code
rewriting or version-catalog framework is needed.
[ticket](tickets/processing-terminal-policy-blocks-corrected-parser-recovery.md).

**missing source images currently reject entire books.**
`services/epub_ingest.py:1107-1127` rejects a referenced image absent from the
manifest. these four files also lack the bytes, so manifest repair cannot fix
them. the three cover-only cases are strong candidates for readable publication
with a durable quality warning. their valid declared cover can be preserved
independently, without pretending it is the missing image. toll is less benign:
eight large frontmatter images are absent, and two later floated images appear
to supply initial letters. their contents cannot be recovered from the archive.
preserve placeholders/alternative text and warning locations; never invent them.

strict archive confinement, decompression/resource limits and sanitization stay
mandatory. publication completeness is a separate fact from safe readability.
the [epub reading-system standard](https://www.w3.org/TR/epub-rs-33/#sec-error-handling)
permits rejection but does not require whole-book rejection for every bad
resource; its reporting guidance favors useful, accessible diagnostics.
partial rendering is a product choice, not a claim that the current policy is
nonconforming. [ticket](tickets/epub-missing-images-abort-readable-books.md).

**the two keats index failures are an omitted publication backfill.**
`services/content_indexing.py:213-218` correctly requires normalized headings.
pure exact-body probes prove current normalization preserves both canonical
texts exactly, is idempotent, loses no authored ids, and produces 14/521 index
blocks. neither has fragment-only links or highlights. letters has a positioned
revision-1 cursor on its existing fragment at offset 52; this living hand has
an empty revision-2 cursor.

repair only stored html through `services/reader_publication.py`, keeping
fragment ids/text/offsets and authored targets, advancing publication generation
and index revision atomically. refetching would introduce unnecessary mutable
source and cursor risk. do not weaken the assertion or reset progress.
[ticket](tickets/old-web-publications-lack-index-heading-normalization.md).

**gutenberg recovery preserves an obsolete adapter.**
`services/remote_file_ingest.py:15-40` already recognizes `.epub3.images` in
the deployed code. `services/media_source_ingest.py:610-634` clones the failed
attempt's original `generic_web_url` type on retry. the current source returns
`application/epub+zip`, zip magic, and the expected gutenberg epub redirect.
source correction must go through the admission owner and preserve filing;
neither an extension patch nor another identical article retry is useful.
[ticket](tickets/gutenberg-failed-import-retains-obsolete-web-adapter.md).

## adjacent findings

| finding | evidence / disposition |
|---|---|
| three old standard ebooks seeds | original urls return an html download landing page; explicit `?source=download` targets return valid epub containers. current oracle mappings already use different gutenberg copies, all readable/indexed. old rows have zero filing/mapping references and are absent from imports. audit lifecycle cleanup rather than restore obsolete copies. [ticket](tickets/superseded-oracle-seeds-retain-unfiled-failed-media.md) |
| two historical note indexes | june uuid-json failures; both notes still exist (25 and 81 characters). current locators/results serialize ids as strings, and a pure serialization probe passed. run owned reindex and verify search. [ticket](tickets/historical-note-index-failures-need-owned-recovery.md) |
| source acceptance/enqueue crash window | source/refresh commit can precede enqueue; reconciler selects extracting media and can miss accepted jobless attempts. static defect; none observed in current inventory. [ticket](tickets/source-acceptance-can-commit-without-enqueued-work.md) |
| reconciliation starvation | oldest 25 dead obligations can occupy every bounded discovery pass. filter owner eligibility before limit; do not auto-redrive dead work. static finding. [ticket](tickets/ingest-reconciler-dead-rows-can-starve-new-work.md) |
| transient storage read treated as lost source | generic storage error is in the non-reacquirable set, although failed head requests do not prove absence. no current failure has this code. [ticket](tickets/storage-outage-is-misclassified-as-lost-source.md) |

one additional retained dead index job belongs to another this living hand
media whose current index is already ready at revision 1. it is historical
queue evidence, not an additional current failure.

the inventory also contains 202 pending podcast media without source attempts;
pending alone is not a processing-failure diagnosis. metadata/generation dead
jobs belong to the separately recorded generation reliability work. this review
does not restart them or represent their prior uncertainty as resolved.

## what the council would ask and dispute

| perspective | first question | judgment |
|---|---|---|
| reliability engineer | which exact source/attempt/revision owns this failure, and what changed before retry? | preserve ownership and history; make acceptance plus runnable work durable |
| parser engineer | what exact bytes reached us, and which stage consumed resources or lost meaning? | profile and replay the real artifact; joyce needs algorithm repair, not larger limits |
| digital archivist | are these original bytes complete, and what will recovery overwrite? | preserve originals and reader identity; missing drop caps/images cannot be invented |
| product designer | what remains usable, and which next action changes the outcome? | show readable/searchable/incomplete/access-denied consequences, with one useful action |
| security engineer | does tolerance expand file/network authority or bypass validation? | missing-image tolerance must not weaken archive confinement or fetch restrictions |

agreement: acquisition, preservation, extraction and indexing are separate
obligations. successful queue settlement is not successful reading. derived
index failure must leave useful source content available. historical evidence
must survive recovery. the smallest correct repair belongs to the existing
domain owner.

disagreement: the archivist resists partial books; product favors access to the
surviving text. resolve this with explicit incomplete-source status and resource
warnings, retaining original bytes. do not publish a false completeness claim.
reliability resists redrive; parsing needs reprocessing after a correction.
resolve this through deliberate admission against an exact failed attempt,
followed by unchanged current validation. neither concern justifies a new
workflow engine for this system.

## practices worth taking

| product / source | observed practice | why it matters here |
|---|---|---|
| [readwise reader](https://docs.readwise.io/reader/docs/faqs/parsing) | browser capture supplies content rather than a naked url; original parsed content is retained to protect annotation context | use the user's accessible browser for blocked sources; preserve stable reading context during repair |
| [zotero](https://www.zotero.org/support/troubleshooting_translator_issues) | separates site-specific translator problems from global setup/access failures; asks for exact url and debug evidence | reproduce the individual failed source before changing general behavior |
| [wallabag](https://doc.wallabag.org/user/errors_during_fetching/) | separates fetching from extraction; uses maintained site rules and explicit re-fetch | put each fix in its owning acquisition/extraction layer |
| [instaparser](https://blog.instapaper.com/2026/03/31/relaunching-the-instaparser-api/) | separates article extraction, pdf parsing and summarization | model interpretation is a derived feature, never proof that source import succeeded |
| [mozilla readability](https://github.com/mozilla/readability) | readerability checks are heuristic; sanitization is separate | a heuristic failure does not establish intrinsic unreadability |
| [amazon retry guidance](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) | bounded retries, clear retry ownership and idempotency | repeated deterministic failure gains nothing; nested retries can amplify work |

[wallabagger issue 366](https://github.com/wallabag/wallabagger/issues/366)
documents concern about apparently successful saves with unusable content;
it is a user report, not proof of a shipped automatic recovery feature.
[readwise's parsing-triage explanation](https://www.reddit.com/r/readwise/comments/1bv24tp/why_havent_i_heard_back_about_my_parsing_error/)
illustrates the long-tail cost of prioritizing widely used sites. our acceptance
corpus should be this user's failed library, including literature and apparatus.

the [wcxb preprint](https://arxiv.org/abs/2605.21097) compares extraction across
seven page types and reports substantial differences outside ordinary articles.
its partly model-assisted annotation process limits certainty. use its lesson
about representative evaluation; it does not justify replacing our extractor
from a leaderboard. product marketing likewise does not establish a universal
best parser.

much of the desired ux already exists: `apps/web/src/lib/status/imports.ts`
routes blocked pages to capture and explains source versus search recovery;
`services/imports.py:826-891` gets offers from their owners. repair these
contracts, including overconfident same-source wording, without rebuilding
imports or exposing internal stages as independent restart checkpoints.

## proposed order, explicit trade-offs, and acceptance

1. repair the shared apparatus cost and add narrow diagnosed-reprocess
   admission. trade-off: a small explicit operator capability replaces the
   current permanent prohibition; exact attempt/source checks and current
   validators remain essential. no generic job redrive or version registry.
2. represent missing presentation resources honestly in epub processing.
   trade-off: useful partial reading requires durable quality diagnostics and
   cannot promise source completeness. prefer replacement bytes for toll.
3. normalize the two stored web publications and correct the gutenberg source
   intent through their owners. trade-off: narrow data repair requires explicit
   identity invariants but avoids unnecessary refetch and annotation damage.
4. run individually observed recoveries for fanged, pierre, joyce, video, x and
   the diagnosed epubs; rebuild the two article indexes and two note indexes.
   trade-off: retained source is reproducible, while live provider availability
   and paid indexing can still fail independently. stop on a new cause.
5. capture the twelve denied pages from accessible browsers. trade-off: user
   participation replaces a scraper-maintenance commitment; availability and
   completeness still need checking. do not auto-delete duplicate tolkien rows.
6. fix the separately ticketed admission/reconciliation/storage defects in
   focused changes. trade-off: they improve future recovery but are not causes
   of the current 24, so they must not obscure the immediate repair slice.

source artifacts, reader state, attempt history and ownership are the invariants.
the production implementation can remain small because the database queue,
publication owner, retained source files and imports inspector already exist.

verification follows `docs/local-rules/testing-standards.md`: `./scripts/test`
is the sole automated command and is static only. this documentation/diagnostic
pass did not run it. implementation needs focused manual real-stack checks:
exact-source output equivalence for apparatus; unchanged security rejection;
missing-resource disclosure; stale recovery rejection; stable text/fragment ids
and saved cursor; successful source publication and independently successful
indexing; current imports count. measure joyce on the deployed worker envelope.
no new test harness, fleet benchmark, workflow engine, storage service, global
cache, arbitrary limit increase or automatic extractor cascade is justified.

local parse success, scratch algorithm equivalence and provider lookup are
evidence for the proposed repairs. production recovery remains unperformed.
[recovery tracking](tickets/processing-backlog-needs-owned-recovery.md).
