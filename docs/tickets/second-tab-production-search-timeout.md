# production search reaches its statement timeout

status: open; relationship to tab failure unconfirmed
origin: 2026-09-13 second-tab council; production `7e8fd48244b3b436965037738e05785bb4931be1`
area: search / foreground latency

retained `nexus-api-1` logs show `http.request.failed` for `get /search` at
`2026-09-13T03:23:03.157180Z`, request
`37593fd6-e86f-40c9-afe8-09d786ba25aa`, followed by an unhandled exception.
the associated content-chunk query reports a postgres statement timeout;
its candidate limit is 4000. no private query text is retained here.

prerequisite: compare the deployed retriever with the substantially changed
current `python/nexus/services/search/retrievers/content_chunks.py`; reproduce
the plan on representative local data. do not assume this remains unfixed in
the current implementation or that it caused the workspace exception.

fix: use indexed candidate selection, bounded intermediate work, and late
snippet construction where the measured plan requires them. verify the
supported corpus and latency budget before changing limits or indexes.

acceptance: the identified query shape stays within its deadline on realistic
local data with concurrent reader activity, with unchanged authorization and
independently checked ranking; retain read-only release evidence. do not
silence the exception or merely extend its timeout.

## 2026-09-14 adversarial review — the spec clause was dropped, and admission made it worse

the bounded-workspace spec's d section names this ticket's work explicitly:
"investigate the recorded search timeout with its real query plan". it was not
done and its omission is recorded nowhere. `git status --porcelain
python/nexus/services/search` is empty — `content_chunks.py` is untouched — and
the string "search timeout" appears in no dossier except the spec sentence
itself.

meanwhile `python/nexus/api/routes/search.py:31` put the whole search router on
`route_class=AdmittedReadRoute`, drawing on the **shared** foreground JSON read
pool (`python/nexus/app.py:142` builds one `read_admission` that `me.py`,
`media.py`, `reader.py`, `reader_publications.py`, `resource_items.py` and
`search.py` all use). `ReadAdmission.serve` holds its slot until the whole ASGI
call completes, and `DATABASE_STATEMENT_TIMEOUT_MS` is still 30000
(`python/nexus/config.py:194`). a query that runs to the statement timeout
therefore occupies a scarce foreground read slot for up to 30 seconds, and a
handful of concurrent slow searches can make every reader unit, index, evidence
and document-map read answer `503`. admission converted an isolated latency
defect into a shared-availability defect.

added fix requirements, on top of the plan work above:

- give search a deadline **shorter** than the admission slot it occupies (a
  per-statement timeout scoped to the search session), so a pathological plan
  cannot become a foreground-read outage for the reader.
- record in the runtime dossier whether search should share the reader admission
  pool at all. if the plan work cannot land in this cutover, the honest interim
  is to take `/search` back out of the JSON read pool and record the deferral.

do not raise the statement timeout or widen the pool: both hide the plan defect
and spend the headroom the spec told us to reserve.
