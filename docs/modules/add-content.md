# add content

status: current contract; verification baseline `f2167baf3`.
scope: add panel/session and same-deploy browser decoding. existing backend
storage, publication and recovery behavior stays owned by its current services.

## behavior

one browser-local session starts from url/file focus, url draft and destination
libraries. desktop focuses the requested source control; mobile the heading.
review extracts distinct valid http/https links in source order. intake accepts
nonempty pdfs through 100 mib and epubs through 50 mib; invalid files stay visible.
all rows count toward twenty; overflow stages nothing. staging clears its input
and focuses the queue. defaults update every draft; rows can override them.

submission freezes source, destinations and idempotency key, with concurrency
two and one mutation per session. source acceptance differs from processing
success; upload publication proves verified bytes. accepted rows release file
bytes and retain identity, duplicate/processing facts and open controls.
unresolved status/retry resends the frozen intent; restage allocates a fresh key.
every sent intent ending in auth or defect stays frozen: urls unresolved, files
retaining exact replay or pointing to imports. one mapping serves submit/check.
idle implies no submitting row. known feedback and request ids stay visible;
auth recovery runs first and defects reach the existing boundary unchanged.
editor create-and-add handles known creation failures there; auth/abort escape
without becoming defects. library creation reuses its allocated id after response
loss. browser ingestion's public functions, errors/outcomes and accepted-result
shape remain fixed for notes, connections, browse, capture, imports and actions.

stop/discard/reset/unmount fence all old reads and writes. stop returns unsent
submissions to draft, started urls to unresolved and started files to imports.
accepted rows remain accepted. confirmations, keep-working and focus stay as
observed; only active mutations warn on unload. reload loses browser drafts/files
while durable work remains in imports.

accepted aliases share placement by media identity. bulk work deduplicates ids,
excludes unavailable media and initially rereads eligibility. only admitted
direct/absent relations change. add admission creates/reuses only video, article,
pdf and epub media; the sole podcast-episode writer allocates new episode rows,
so parent-show inheritance cannot enter this session.

transport-class failure, sent defect or stop-after-send retains each exact
(media, destination, verb) and inventory. retry sends only those retained triples,
without an inventory prerequisite or changed-selection inference. refusals settle
with feedback and no resend; media-not-found is terminal unavailable. unavailable
rows have no retry and contribute neither bulk options nor bulk error banners.
reads never erase uncertainty. only settled retry, a later write command's
successful eligibility read, last-alias removal or session end clears it.
editor-open/refresh reads do not count. per-media reads and writes exclude each
other; late completion cannot overwrite a newer owner.
retry auth restores the original uncertainty; sent defects reach the boundary
after retaining their exact command.

send is recorded synchronously before dispatch; acknowledgement installs the
confirmed relation in the same continuation, without await or follow-up read.
stop/admission use that synchronous snapshot. queued retries restore their prior
uncertainty unchanged; sent unacknowledged writes keep their exact triple.
acknowledgement cannot be demoted by a later read. direct retry is essential:
removing the viewer's last readable path makes inventory return 404 although
the exact delete still succeeds (`services/library_entries.py:578-580,761-782`).

## ownership and qualification

`useAddContentSession` owns one immutable snapshot shared with its synchronous
ref; item/placement variants own progress. the panel renders that contract through
existing ui/library primitives. generated native types own success shapes;
preserve bytes, envelopes, fields, aliases and statuses. the independent
extension alone retains `uploadSessionContract` decoding. browser ingestion owns
signed-put expiry/deadline, failure reporting and confirmation; its raw storage
fetch, without nexus credentials, owns credential separation.

real task-owned auth/bff/api/postgres/storage passed twenty old/new public api
cases, six exact serializer comparisons, five moved extension decoder variants
and final url create/replay/provider reuse checks. mounted ui passed mixed
url/pdf, lost file publication/defect recovery, two-account last-readable delete,
terminal404 with continuing bulk, desktop/mobile focus and overflow checks.
the mounted public hook passed five rows/four media dedup, frozen retry after
selection changes, ack/sent/queued stop, alias retention, old-response/reset
fences, sent defects and retry401 with real login redirect. faults/401 came from
external egress injection; native producer faults are not claimed. browser
errors were empty. worker/provider extraction, permissions changing during retry,
file-stop phases, reload/imports ui and every admission-limit variant were reviewed
in source only. `./scripts/test` is the sole static gate.

intentional changes: frozen auth/defect recovery, terminal unavailable/refusal
classification, retained per-media uncertainty and explicit placement retry
replace their defective baseline paths. retry may need one extra action; other
panes may remain stale until a successful retry publishes or another revision.
successful duplicate adds may advance revisions twice. remove the unread
`?duplicate=true` parameter; retain the duplicate status fact.
