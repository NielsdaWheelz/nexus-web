# selection

browse, contextual suggestions and daily use one librarian editorial pipeline.
quick reads applies its direct time/progress predicate without generation.
`services/suggestions.py` owns bounded candidates, eligibility and hydration;
`selection_context.py` owns committed intent; `daily_selection.py` owns calendar
windows and publisher evidence; `suggestion_shortlists.py` owns admission,
editorial output acceptance, publication and queue handlers. shared search,
generation, tool, resource and consumption owners retain their contracts.

## product

| surface | eligibility | publication / display |
| --- | --- | --- |
| browse | visible unfinished individual media, including held and older work | 20 / 20 |
| lectern suggestions | visible unfinished media absent from lectern | 20 / 10 |
| library suggestions | visible media absent from an administered library; a named library also admits followed sources it does not file | 20 / 10 |
| daily | held individual media acquired in the prior account morning window, with current publisher evidence and usable reading, audio or source link | 5 / 5 |
| quick reads | complete current readable documents, unfinished, `0 < remaining_seconds < 600` | direct 5 |

system/member-only libraries have no contextual selection. a full lectern keeps
suggestions readable and disables additions. losing library administration deletes
its feed and publication through the existing library owner. recommendations never
save resources or create graph links merely because the librarian chose them.

one retained pane visit owns its adopted order, rationales and scroll. contextual
vacancies refill from that finite pool. a new background publication does not
replace an adopted pool, including an empty or exhausted one. current eligibility
and capabilities update through `/view`; it returns no replacement rationale.
a ref acknowledged after a read began cannot reappear from that read. closing a
visit follows the existing pane owner’s forgetting rules; no extra storage owner.

explicit refresh adopts the latest completed publication through its own bounded
read, never waits for a model. initial absence adopts the first completed pool.
empty is a successful publication. failed reads keep the last adopted content;
matching read success clears only that intention’s failure. queue repair and read
retry remain separate. routine publication and observation are quiet.

quick reads remains immediate and model-independent. in-progress works precede
lectern/context preference, then engagement/recency. complete reader publications
prove duration; excerpts and unknown extents do not qualify. rationale is null.

## context, retrieval and editorial judgment

bounded intent combines recent reading/listening, notes, highlights, individual
saves and recent committed user questions. retries, assistant answers, automatic
arrivals, unsynchronized writing and local opens add no votes. the first currently
visible media attachment of a question supplies a resource anchor; each recent
question keeps its own lexical anchor, including successive questions about the
same work. repeated resource actions advance its clock, not its weight. user text
stays bounded by the existing context owner.

retrieval combines destination anchors and intent through graph, shared-author,
lexical, stored-vector and recency evidence. canonical identities break ties.
existing twenty-per-family retrieval and soft diversity supply at most 80 offered
candidates. daily retains its source preference before the other soft preferences.
bounded retrieval may miss good work; the model cannot choose a context-only ref.

one `selection_curation` generation runs under owner `suggestion_feed`, codex
personal `gpt-6.1-sol`, medium reasoning, strict json, 180 seconds and 256 kib input.
`SelectionRead` grants only resource inspection, current resource reading and
document search, scoped to offered candidates and intent refs. no web discovery,
shared memory, authored writes, saves, subscriptions or graph writes. no alternate
model or mechanical fallback. all tool reads still enforce current visibility.

input contains the manual reading brief, surface constraints, bounded intent and
canonical target projections. retrieved material and prior messages are evidence,
not instructions that can expand authority. the brief has no inferred biography
and only the user edits it in librarian settings. a changed save advances selection
input revision; the publication fence compares its captured brief version.

output is exactly `{items:[{ref,rationale}]}`: unique offered refs, at most twenty
(or five daily), with a nullable plain-text rationale of at most 240 characters.
invalid shape, duplicates and unoffered refs reject the entire attempt. fewer or
zero picks is valid. model prose cannot replace titles, urls, dates, artwork,
durations or capabilities. no quota-filling, invented popularity or endorsement
chips. select for substance, deliberate relevance, intellectual stretch and variety.

content acceptance: one supported sentence, or null. metadata can justify topic
relevance but cannot establish an unread argument. `a primary account of the
dispute you’re studying.` is good only when both claims have evidence.
`an insightful must-read perfectly tailored to you.` is empty praise. app-authored
copy is lowercase; source identities and quotations keep their original case.
empty browse says `no picks right now.`; suspended updates say
`selection stopped updating.` while retaining prior rows.

## publication and scheduling

`suggestion_inputs` retains the existing per-source clocks. canonical mutations
advance only their owner identities in the same transaction; aggregate reads
include late commits. reading/listening marks dirty only when an anchor or read
state changes. manual brief and calendar-zone changes mark dirty too.

`suggestion_feeds` names account, mode and nullable library, with its current job
and `last_admitted_at`. `suggestion_shortlists` stores only the latest successful
ordered `{ref,rationale}` items, captured revision/time and optional daily metadata.
no edition archive or candidate/source copies are stored here.

first non-daily work is due immediately. later new admissions require meaningful
input change or a new account-local day and at least fifteen minutes since the
last admission. the floor applies after failed/superseded initial work too.
existing work, including suspended work, keeps its job and budget. the explicit
same-job repair owner retries failed work; navigation and dirtiness cannot bypass
it. no age-based fifteen-minute refresh or thirty-second build delay remains.
active reading can cause one build per visible feed per fifteen minutes; there is
no freshness guarantee under contention.

one existing `suggestion_shortlist_refresh` job performs:

1. read-only repeatable-read candidate/context capture under shared bounded search
   admission; record current brief version and database time.
2. retire the search backend and transaction completely.
3. run generation through its existing ledger, runtime and scoped tools.
4. validate schema, candidate membership, uniqueness and surface cap.
5. a short serializable transaction locks account then current job claim, checks
   feed pointer, destination authority, brief version and daily window. recheck
   selected eligibility; remove newly ineligible rows without substitution. replace
   the previous publication, clear the pointer and finish the job atomically.

zero survivors publishes empty. malformed/model failure retains previous success.
brief supersession clears and finishes that job without publication, leaving new
inputs due through normal admission. a lost claim cannot publish. interrupted
search retirement fails its existing capacity owner closed. only observed search
admission contention reschedules the same job at database now plus five seconds;
setup/computation failures retain normal bounded failure policy.

## daily

cutoff is 07:00 in the account’s calendar zone; the existing minute scheduler
admits the latest due edition without a mounted browser. first success fixes the
edition, including empty. missed editions are skipped, not backfilled. a timezone
change cannot publish an old captured window; the next window starts no earlier
than the previous successful cutoff. later windows can supersede failed older work.

daily candidates were acquired in the previous civil morning window from currently
followed sources or individually saved articles. history/unknown acquisition is
excluded. choose the earliest credible publisher fact across occurrences and reader
publications; never import, update or model-enriched timestamps. instants qualify
within seven civil days of cutoff; dates qualify within the edition day and six
preceding dates. initial admission and publication require a current readable
publication, playable audio or authorized source link.

daily `/view` only checks existence, access, metadata and action capabilities.
finishing, filing or unfollowing cannot replace an adopted edition. publication
prefetches at most five linked articles through the existing source owner; it does
not request model enrichment or delay the edition. the scheduler re-offers the same
nominations and attempt ids after source work settles without resetting budgets.
coverage captures followed sources whose current head succeeded without gaps in
the hour before cutoff. archive checks do not count; incomplete coverage stays
visible even with selected rows.

## ports and repair

`/browse/selection`, `/lectern/suggestions`,
`/libraries/{library_id}/suggestions` and `/daily-brief` expose the same protocol:

- `GET`: `{observed_at,state,publication}`; publication is null or
  `{id,edition,items:[{target,rationale}]}` with current targets.
- `POST /view`: `{refs}`; returns current `{target}` rows in requested order.
  at most twenty refs; daily at most five; browse/daily accept media only.
- `POST /refresh`: no body, returns 202 after ordinary due admission/join, never
  waits for generation. GET alone does not admit work.

state retains input revision, latest id, queue phase, capability and automatic
advice `Now | At{at} | Stopped`. mounted observers separately request refresh using
that advice; existing observation cadence is thirty seconds or ten during active
work. suspended work does not poll fast. `/lectern/quick-reads` stays a direct GET.

repair the recorded failure first, then use the existing queue
`resume_held_job` on the feed’s still-current `suggestion_shortlist_refresh` job.
retain its identity, feed pointer and prior publication. confirm it publishes and
clears the pointer; deleting a suspended row to obtain a new attempt budget is not repair.
