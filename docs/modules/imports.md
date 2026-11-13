# imports

imports answers whether something arrived, what needs the reader, and what happened
to one import. its register is one list: raised attention, active work, then arrivals
under local day heads. it owns the read model, per-reader dismissals and narration;
source acquisition, search, metadata and feed commands retain their own owners.

owners: `python/nexus/services/imports.py` (all reads),
`services/import_dismissals.py` (the one dismissal write),
`services/import_history.py` (source/session narration), `schemas/imports.py`
(wire), `schemas/import_history.py` (stages, failure vocabulary and events), and
`api/routes/imports.py`. web: `lib/imports/` owns observation, reads, commands,
url and copy; `components/imports/` owns the register, actions and inspector.
`components/feeds/` owns batch rows and records. `CollectionView` owns list
focus, return scope and refresh anchoring.

## concepts

- **import.** `media:<id>` names visible source/metadata work, including published
  browser captures. `upload:<session id>` names local uploads before and after
  publication, and unbound unpublished browser captures. a bound unpublished
  capture belongs to its target media. published browser upload refs retire
  without redirects; session and event identities remain unchanged.
- **obligation.** nullable source, search and metadata slots report their owner's
  true classification. null means nothing applies. lexical publication remains
  readable/searchable independently of semantic indexing. pending capture slots
  describe their own session and issue no source recovery offer.
- **raised.** an attention obligation whose failure instant exceeds this reader's
  dismissal. an import needs attention if any obligation is raised, else is active
  if any is active, else complete. primary speaks among raised slots, then active
  slots, in pipeline stage order; it is null exactly when complete.
- **arrival.** the earliest `coalesce(finished_at, created_at)` of a succeeded
  source attempt this reader created on this media, excluding podcast transcript
  requests. refreshes, repeated acquisition and other readers' work never move it.
  a superseded acquisition on another media creates no arrival on its winner.
- **dismissal.** the reader's monotonic acknowledgement of a media's failures
  through one observed instant. it changes no obligation, content or history.
  a later failure raises attention again; dismissal has no undo.
- **pointer.** the submitted link's hostname and path without query or fragment,
  else the original filename, else null. admission's stored title is separate.
- **record.** append-only source/session narration plus metadata operations
  projected at read time. it is read while the detail surface is open and is
  never a recovery or classification owner.

## wire and storage

all reads are authenticated repeatable reads with the ordinary `Data{data}`
envelope. the web reaches them under `/api`.

| route | request | answer |
| --- | --- | --- |
| `GET /imports/summary` | none | `{observed_at, needs_attention_count, active_count, work_in_flight, digest}` |
| `GET /imports` | `view=Register` with offset-bearing `from`, or `view=Recent`; optional cursor and limit 1..100, default 50 | `{items, next_cursor}` |
| `GET /imports/{ref}` | none | `{item, source_issues, related_imports, pending_captures, original_source, email_source}` |
| `GET /imports/{ref}/history` | cursor, limit 1..100, default 50 | `{entries, next_cursor}` |
| `PUT /imports/dismissals` | `{dismissals: [{ref, through}]}`, 1..100 offset-bearing instants | 204 |

the page refuses every other parameter and all former views with 400
`E_INVALID_REQUEST`; invalid or mismatched cursors answer `E_INVALID_CURSOR`.
Register includes all unsettled imports and complete imports arrived at or after
`from`. keyset order is attention, active, complete; newest raised failure,
acceptance or arrival respectively; then ref. Recent retains its existing own
acquisition membership, supersession and newest-acceptance order. its only reader
is the import page's shelf. there is no count query or event matching.

an item carries ref, media id, title, original filename, media kind, nullable
`MediaSummaryOut`, pointer, arrival, nullable dismissal offer, covered slot names,
read/play/text readiness, classification, primary, acceptance/update instants,
three obligations and source issue count. a linked media always has its summary.
source/search obligations carry their true classification, stage, active status,
waiting reason, counted progress, retry instant, failure code and exact recovery
capability or restriction. metadata uses its owner's existing view.

`import_dismissals` has database-generated uuid id and creation time, required
user/media references, an offset-bearing through instant and unique user/media.
foreign keys do not cascade; media hard deletion explicitly deletes dismissals.
one serializable retry transaction owns each request. each item independently
resolves visibility and media identity, including published upload refs; missing,
invisible, unpublished or already covered imports do nothing. select, then insert
or update coverage to `max(stored, min(requested, newest raised failure))`.
malformed bodies alone refuse the request. web commands echo the offered through
string verbatim, send at most 100 per request and invalidate once afterward.

## observation

the summary remains the shell's one passive 30-second observer. presented busy
consumers accelerate it to 10 seconds while `work_in_flight` is true. held work
does not accelerate it. hiding retires optional reads; return observes immediately;
a failed summary waits for a wake or explicit retry.

every imports read except summary waits for the first digest. revision advances
on manual refresh, in-tab imports invalidation and entry changes. list, details,
record, shelf and batches reread only when revision or digest moves, retaining
accepted data after refresh failure. the intake's source truth continues to use
the observation clock under its separate contract below.

the digest hashes ordered jsonb arrays, including nulls, over all unsettled
imports, arrivals within 32 elapsed days and unsettled own opml batches. 32 days
covers thirty local calendar days plus today across daylight-saving changes.
inputs cover classification/primary, slot stage/code/classification, source
attempt/status/progress, source/index/latest metadata jobs and availability,
arrival, text readiness, source issue count, coverage, media update and pending
capture/session facts. job lease-only update timestamps are excluded. batches
use identity, state, attempt version and admitted/remaining/failed counts.
empty sets hash as empty strings. arrived row summaries resolve through the
shared media summary store so reading facts can change independently.

## register and details

the visit computes local midnight thirty days back once in `displayTimeZone`.
the url owns only `/imports?selected=<ref>`; tolerant decoding admits one upload,
media or opml segment. the next write drops other parameters. restored selection
never opens details; explicit activation does. imports publishes an Import primary
action and refresh capability, with no navigation, query, views or toolbar.

Register uses `useServerList`, 50 rows per page, `drain: false`. rereads replace
the loaded prefix. load more queues behind a reread; if that read fails, its
requested continuation shows retry, and a later load-more press retries the prefix
before continuing. passive same-query refresh failures stay quiet. all loaded rows mount; heads prohibit windowing. attention and
importing heads use summary counts plus their batches. batches precede their
group; active batches wait until the loaded prefix has passed attention. finished
batches leave. day heads use the display zone. final colophon hands earlier
arrivals to all through the existing profile's default library id.

arrivals use the library's `presentMedia` and `CollectionRow`, with Import details
as an occurrence action. unsettled work uses an Index `ResourceRow`: title when
readable/playable, else machine-ink pointer, else stored title; one status line;
one offered shortcut; the ordinary contextual menu. counted source extraction
alone paints an accessible progress hairline. group arrival and pointer-to-title
motion obey reduced motion. custom rows preserve collection and focus markers.

capabilities alone issue verbs. metadata retains its actions; source upload retry
says `choose it again`, source recovery `retry`, search repair `rebuild`, an
unpublished upload without recovery `remove`, else offered dismissal `dismiss`.
row shortcuts require raised attention. media menus lead with Import details,
the speaking recovery and Dismiss, followed by ordinary work actions. retry all
walks loaded source/search recoveries sequentially despite refusals; dismiss all
sends batches of at most 100, with one invalidation. partial attention prefixes show counted verbs.

the companion surface remains `import-detail`, with identity; one standing Fact
per unsettled slot and covered markers; pending captures and discard; related
imports, source issues and metadata; the mounted record; particulars last. email
provenance stays private to the original creator and retains its received-by-email
strings. identifiers appear once in particulars. no history/diagnostics disclosure,
Open button, matched mark or retry-explanation sentences remain.

`copy.ts` and `words.ts` own line phrases and feedback verbs; `importLine` supplies
register and shelf, reading the speaking slot, readiness and dismissal. tone is
neutral without raised attention, otherwise danger if neither readable nor playable,
warning otherwise. designed lines use at most fourteen words. catalog actions
retain their own labels. `lineView` shares phrases through `words.ts`.

## invariants

- **I1** summary, page and detail use one classification cte; separate reads can observe different moments.
- **I2** only Register and Recent exist; Register requires its arrival bound and Recent refuses one.
- **I3** every shown source/search code is catalogued; unknown queue codes read as a handler failure, without aborting queue transitions.
- **I4** owner transactions alone append history through `import_history`; queue hooks skip settled source attempts and deleted media, and dismissal appends nothing.
- **I5** arrival is the reader's first successful direct acquisition; only raised failures affect attention and primary.
- **I6** selection persists without opening; explicit activation opens the same companion surface for import or opml refs.
- **I7** commands share existing per-resource busy ownership; upload uncertainty retains its live owner.
- **I8** reads wait for digest and react to revision/digest changes, not clock-only summaries; the record mounts while details are open.
- **I9** page refresh atomically replaces the loaded prefix; an action during reread queues load more, and a failed refresh keeps accepted rows.
- **I10** CollectionView preserves surviving row focus, else chooses the next row; final load-more focus goes to the colophon link.

## feedback and uncertain admission

`Fact` presents durable operation facts and absent content; `Failed` owns a
settled read failure where the object would stand. shown content survives a
failed refresh quietly. retry retains its error and control while busy.
recorded history stays domain content.

`lib/media/admissions.tsx` owns live source-refresh and metadata-research
submissions. its account-keyed shell provider outlives panes and registers
unacknowledged requests with the common loss guard. one entry per kind/media
keeps the submitted bytes and original expectation in memory; retries send those
exact bytes with the existing 30-second response deadline. fresh source refresh
requires an observed settled-attempt capability. metadata replay may answer the
current qualifying job, rather than prove receipt of the original click.

entries are sending or unconfirmed. acknowledgement or a definitive first-attempt
refusal retires the exact entry; a later refusal after uncertainty leaves it
unconfirmed and refreshes canonical reads. a mounted `Hold` offers `retry`,
which sends the retained request. tucking it changes presentation only. no
discard command is exposed: settlement or an approved account/document
departure ends the retained uncertainty. a captured entry object fences late
replies from clearing or modifying a replacement. account teardown removes its entries.
the entry retains its actual last api error. a wire mismatch after uncertainty
keeps the request and its loss risk, while the shared stale-build notice and
local controls offer only reload. the retry capability also refuses that stale
entry, including calls from previously retained controls.
there is no storage, startup restore, replay or browser-restart recovery. other
commands keep their existing owners and retry rules.

`lib/imports/commands.tsx` owns upload and capture-removal commands for one
imports visit. list rows and the companion use that same owner. pending and
uncertain commands retain their own controls across row movement, selection and
inspector closure; those presentation changes prove no outcome. the common
work guard protects their in-flight and uncertain lifetime. removal and discard
name the same session deletion, so acceptance settles that one intent.
an authoritative filing refusal retires uncertainty but retains the same file and staged
generation for explicit review. that retry reads a fresh guard; a failed guard read retains
the command without claiming uncertainty. neither a read nor a restored view sends a command.

every attempted source or metadata admission wakes imports, including an unknown response. metadata admission and personal review also invalidate the media's existing finite observation. departed accounts cannot publish those effects into their successors.

## intake

`lib/imports/intake.tsx` holds one document's lines: each one thing coming in, one identity
from enter until it is readable, behind every door. `lib/imports/lineView.ts` words a line
for every surface and for the intake's slips. nothing survives a reload.

a distinct admission of a remote pdf or epub url may create another media item even when that address was imported before.

- **provider.** `ImportIntakeProvider`, above the workspace boundary and keyed on the
  nullable account, owns the store, the send queue, creation and one document-local
  `import-intake` work owner. a real account change retires that whole lifetime; share
  passes null for its document without provisioning notes or inventing an identity.
  it publishes a defect and throws nothing.
- **host.** `ImportIntakeHost`, inside `ImportsProvider`, throws that defect in render, owns
  the one `useDestinationCreation` for `into`, reads truth, opens armed lines and raises
  slips. share has no host, so no truth: its accepted lines read `sent`.
- **admit** never throws: every outcome is a line, or its caller's `Field` (the caller
  parses with `extractLinks` and holds `ADMIT_LIMIT`). a link already listed adds none.
  type, emptiness, the size limits and create's name rule refuse a file before any request.
  an admission into the visit's `into` waits while a library create is sending, keeping that
  `into`. a created library joins the `into` of the visit its latest send began in, while
  that visit lasts, and that visit's waiting admissions either way: a create that outlives
  its visit never sets the next one's, and one retried in a later visit files for that one.
  a retry sent while closed joins no visit or deferred admission.
- **send.** enter's one `GET /libraries/destinations` freezes each line's guard: the removal
  revision and its libraries. a failed read is `no start`, or `offline`, and so is a send
  the shell's admission holds at its start, when no earlier send went unanswered. a held
  replay stays unknown: that acquisition did not run, but an earlier one may have landed.
  a held first confirm reads `couldn’t check the file.` with the transport's reason: the
  bytes are up and the check did not run. links go one at a time and file puts two at a
  time; a link's accept and an upload's confirm, both serializable under the viewer lock,
  take one slot between them. every send answers within 30 s, the put within its upload window.
  acceptance drops a file's `File`: nothing sends it again.
- **answers.** a line is unknown only where an answer was lost after the server could act:
  a link's accept, or a confirm. a lost answer before confirm published nothing: `upload
  stopped`. 401 and 426 answer before any route: handoff on a first send, still unknown
  after an earlier unanswered send. exact pre-route `E_AUTH_UNAVAILABLE` likewise preserves
  uncertainty, or uses no-start/check-held for a first acquisition/check with the shared busy
  reason. the shared upload attempt owns confirmation uncertainty; the intake has no second flag.
  a storage failure at a first confirm published nothing:
  `couldn’t check the file`; after an unanswered confirm it is
  unknown. a refused create forgets the attempt's guard; a fence or library refusal at
  confirm opens it to review. an undeclared refusal reads `couldn’t import this.` and warns
  its request id.
- **replay.** `retry` sends the same id, guard and session again. `changed` takes one reread
  for the batch's changed lines and its waiting lines that replay no unknown, and `library
  gone` one for its own line, whatever the line's verb. a reread gives a link a fresh id.
  `offline`, `no start` and a held check send the batch's held lines again: a line holding a
  guard keeps it and its id, since an id only goes out with one guard; a line whose freeze
  failed rereads. `retryWithout` drops every library the refusal's reread found missing.
  `reselect` starts a fresh session; the expired one stays in imports.
- **truth.** for accepted, unsettled lines, on acceptance and each clock advance, one pass
  at a time, with membership frozen at its start: `GET /media/source-attempts/{id}` per link, two at a time, following
  supersession; `POST /media/summaries/resolve` over the media ids, 100 a request; and for
  a failed or dead run one `GET /imports/{ref}`, which decides readable, the reason or
  removed. each read answers within 30 s. a line whose own read fails sits the pass out,
  holding no other back; a failed summaries read fails the pass. either waits for the next
  advance. new arrivals wait for the next pass; summaries use the included lines' current
  identities after their source reads. the host retains the observer while any accepted line is unsettled.
- **slips.** a batch wholly settled while the controller does not show lines
  raises one slip through `useOutcome().say`; with an unknown line it holds one, whose
  `retry` replays that batch's unknown lines. a batch that settles while a surface shows
  lines never slips, then or later: that surface speaks its settle. opening owns the
  presentation before admission, including immediate refusals before the page mounts;
  deferred admissions use the same current decision when they settle.
- **settlement date.** the intake records when it first observes a wholly settled batch,
  not the server's completion time. the page's displayed and spoken colophon use that
  instant in the reader's zone. edits, back and partial dismissal retain it; retrying an
  unsettled batch drops it until settlement recurs. a batch with no remaining lines and
  account teardown discard it. published snapshots keep their timestamps immutable.
- **`×`** removes a waiting or settled line. forgetting an unknown line, or a waiting replay
  of one, asks `window.confirm` first, since either may have landed.
- **visit.** the intake owns the field, its attempt feedback, destinations and whether a
  nonempty admission was made. admission marks the visit even while library creation holds
  it; draining that admission later changes no later visit's facts. the controller starts a
  visit synchronously at the palette's opening edge; a closed palette has none. explicit field
  replacement and new file admission clear attempt feedback; the link sieve owns its
  remaining-prose feedback.
- **disarmExcept** retains only an explicitly selected line's open intent and clears every
  deferred open intent. input, a drop and leaving the import page pass no selected line.
  this retires navigation, never an admission or its frozen filing destinations.
- **endVisit**, on the palette's close edge, resets the visit and disarms opening; readable,
  superseded and removed lines leave. everything else stays until `×`.
- **surfaces.** the controller publishes whether the [import page](app-navigation.md#the-import-page)
  is open before any admission or close publishes into the intake; nexus's root reads
  only `unsettled`. nexus's back table reads the intake's visit admission fact; it owns no
  second send flag. arrow back keeps the visit, including its field feedback.
- **speech.** `useImportPresentation` observes consecutive synchronous intake publications,
  not rendered row order. binding starts from existing history; cleanup unsubscribes before
  releasing presentation ownership. while the import page is open, its one polite owner publishes starts and
  outcomes. unpublished sentences combine in order with repeats preserved; acknowledgement
  follows the exact occurrence's committed live text. leaving the page retires pending
  speech. returning or replacing the responsive presentation never replays old settlements.

### document doors

`components/imports/ImportDoors`, mounted beside Nexus's desktop/mobile branch, connects
window bubble events to its existing admission and batch-start announcement. the topmost interaction owner alone decides
whether a drop can enter the import page; its semantic marker must be inside that exact
owner. an exposed import page keeps its origin, draft and destinations. an outside drop
opens it through the ordinary intent, retaining the actual opener.

claimed events, editables and other overlays keep their input. internal drags never import.
every remaining unowned file drop prevents browser navigation, including a refused drop;
native file inputs keep their default. the pointer-only veil hides on ownership loss,
root leave, cancellation or blur. a whole explicit-url paste outside input and overlay
owners opens a root draft, never sends. the existing parser owns what counts as a link.

doors reject more than 100 files into the visit's field feedback without admitting any.

### accepted-source pane

the first attempt read shows a `Ruling`; an accepted unsettled source shows its waiting
fact and `all imports`. only a settled identity replaces the route with its reader;
an exact dead source job settles identity without declaring content usable or successful.
explicit repair, retry or refresh can reopen identity work.
that passive replacement preserves the active pane and its open controls. the
poll returns its read promise, so a slow source read completes before another starts.
unfinished presented source attempts use the shared 10-second cadence; demand
retirement cancels optional retries and preserves the accepted identity.
missing or invalid attempts show their refusal and `all imports`; other read failures
compose the import fact with the shared transport reason and actionable remedy.
the body publishes a pointer title role. the shell uses the current visit's retained
hint, with its existing 512-character bound; an unhinted visit keeps its ordinary title.
readable intake lines retain their source pointer on this handoff too. the body withdraws
its role when the ordinary reader takes ownership.
the rail reads unsettled work from the intake; a library door supplies that library's
destination through the same navigation intent.

- **I11** one acquisition step (a link's accept or an upload's confirm) is in flight per intake.
- **I12** a line once unknown keeps its frozen id, guard and confirmation until an
  authoritative refusal permits `changed` or `library gone` review, or a reselect
  re-freezes it. refreezing retires that confirmation and its uncertainty; every retry before then, a held
  send's included, replays them, never a fresh read. an unsent or pre-route-refused retry
  preserves that uncertainty and its dismiss confirmation.
- **I13** `running` counts waiting, sending, uploading and verifying lines; `unsettled` adds
  accepted lines not yet readable, failed or removed. the work owner stops browser work while
  `running` is positive and is unconfirmed while a line sends, verifies or is unknown.
- **I14** with no lines the intake sends nothing and holds no timer or observer.

## standalone share

`app/share/ShareCapture.tsx` reads `/_nexus/shared/manifest` before offering admission.
only the actual share activity answers 200 with its indexed file metadata; hosted
documents and the main activity answer 404. the manifest owns automatic admission,
native `capture_*` metadata and `nexus-share` exits. a bridge or route supplies none
of that authority. main's standalone document initializes its existing native hello
and subscription; the manifest never changes remote admission.

manual cards require a press for links and plain text. links and named files admit
through the same intake into implicit all, without a host, destination picker or
slips. a native stream's 404 is an unreadable null-file line; it never acquires.
files exclude plain capture and the empty-share state; accompanying prose is ignored
while links remain. each stream has a bounded read, cancelled with its document;
failed reads use the existing failed-read repair owner.
absent native name, size or mime type stays null in the manifest. the File boundary
uses its standard empty name/type, and actual readable bytes supply File.size.
unreadable entries retain unknown size; no zero or filename is invented. the existing
admission order groups links, readable files and unreadable entries, preserving order
within each group rather than across a mixed manifest.

only a nonempty admitted set whose every retained line is accepted automatically
closes the native card. refusal and uncertainty remain until recovery or a guarded
explicit exit; ordinary browser/main acceptance keeps the card until done. without a truth host, accepted neighbors read `sent` and no current
share line can offer `see why` or `open original`. real ambiguous and auth refusals
retain their import and sign-in routes. exits use ordinary workspace paths unless
the manifest established the actual share activity.

plain text keeps its authored command, first-send date/id and exact retry handle;
actual sharing retains its native capture identity. its standalone authored provider
receives an explicit workspace return action for recovery. ordinary done/cancel go
home; authored recovery opens downloads, whose workspace owns sign-in and setup.

## acquisition recovery

[ingest](ingest.md) owns guarded admission, upload publication, receipt lifetime
and current-reference supersession; [libraries](library.md) owns retention and
placement revisions. import views never infer current saving from a past receipt.

the intake retains live upload attempts. callers prepare acquisition guards separately
from sending, so a failed guard read cannot become an unknown write. an authoritative
filing refusal permits review against the same staged generation before expiry.
technical busy replies and unanswered confirmations retain the exact command; an
in-call abort lacks a dispatch fact and conservatively preserves uncertainty.
callers read the shared upload attempt's `confirmation_unsettled` fact. a published
receipt or authoritative terminal confirmation clears it; local expiry before a
new dispatch cannot settle an earlier unanswered confirmation. when bytes
can no longer be resent, retry still replays that confirmation for its actual outcome.
losing the owner requires file reselection; replay state does not survive browser
restart. imports exposes its existing retry-upload action, not a second live
confirmation or placement owner.
