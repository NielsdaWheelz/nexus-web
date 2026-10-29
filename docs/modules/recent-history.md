# recent resources

recent is device-local recall of deliberately accepted resource use. it retains
100 unique targets, newest first; nexus shows eight when blank and searches all
retained titles in ordinary unfiltered search. utilities, commands, external
sites and uncommitted creation forms are excluded. open panes remain eligible.

## owners

`lib/recent/model.ts` owns targets, validation and ordered mutations.
`lib/recent/store.tsx` owns the authenticated capability, serialized submission,
observations, invalidation and feedback. workspace, playback and the isolated
shelf report accepted use; the palette never infers use from rendering.
`paneRouteModel.ts` projects supported routes into identity and reopening href.
`workspace/presentations.tsx` resolves current facts without promoting entries.

browser storage is the `recent_targets` record in the existing indexeddb
`binding` store. a strict transaction checks the admitted binding lifetime,
account, retirement and history epoch before reading and changing the record.
retirement deletes history and its binding lifetime together. android stores
`recent-targets.json` through `RecentTargets` under `DeviceSession`'s serialized
file access and captured account lifetime. neither storage is a workspace field.

## contract

the account-bound operations are open, read, use and reconcile. native framing
names them `recent_open`, `recent_read`, `recent_use`, `recent_reconcile`; the
renderer supplies an opened epoch, never account authority. opening absent
history establishes a fresh epoch. mutations cannot recreate absent history.
malformed persisted state fails without replacing its bytes.

each entry stores a structured target, canonical href, nullable title/detail
hints and `used_revision`. the snapshot stores format version one, account,
epoch, positive int64 decimal-string revision and ordered entries. empty history
starts at revision one. hints contain settled facts, normalized whitespace and
at most 512 unicode code points. no bodies, timestamps or usage counts are saved.

use promotes one target and trims to 100. reconcile requires the observed
`expected_used_revision`; missing or subsequently used sources are unchanged.
metadata, confirmed removal and alias coalescing advance the snapshot revision
without inventing a use. merging keeps the newer use and reopening context;
existing canonical facts outrank alias hints. stale metadata cannot borrow a
newer visit's revision. temporary preview/daily identities become canonical
through their owning resource's evidence.

commands enqueue in accepted invocation order and never delay navigation,
writing or audio for durability. writes are one-shot: uncertain completion
rereads and never replays use. browser broadcasts and native `recent_changed`
carry invalidation only. readers also refresh on palette open and foreground
return. read failure retains the last usable list; write failure is separate
from metadata failure and never becomes a playback failure.

## capture and presentation

accepted navigation, deliberate pane activation, back/forward and closed-pane
reopen count. the first visible foreground resource counts once per document
and account epoch, including reload/restore; inactive restored panes do not.
unchanged target focus, automatic successor focus, layout and metadata do not.
chat reopening retains meaningful branch context; passage selectors do not
create separate resource identities.

explicit accepted play/resume and playing previous/next count at the executing
owner. browser acceptance follows the exact resolved audio play; android owns
native playback even with a suspended webview. natural advance, restoration,
pause, seek and paused queue editing do not count. ordinary recent activation
opens/follows the reader and never starts audio.

the shelf acknowledges a successful current visible open through its held
reading lease. native admits one acknowledgement per lease and checks the live
document/account. history failure cannot fail the accepted reader open.

the existing presentation owner combines local authored facts, current remote
or catalog facts and nullable stored hints. failed reads never prove deletion.
the palette registers its held targets with that owner until close, query change
or refresh, so closed readers do not prevent availability checks. captures use
the existing batched presentation endpoint in a separate read behind the current
authored upload watermark; this cannot delay other titles or reader feedback.
canonical candidates coalesce before caps; authoritative titles determine
relevance. filtered search uses structured sources, never guessed hint metadata.
after interaction, blank-list membership/order and activation remain fixed until
reopen, query change or refresh. metadata updates in place; confirmed deletion
removes the row and its activation without selecting a replacement.

## server boundary

query-selection learning remains server-owned: `GET /me/nexus-ranking` returns
only frecency, and `POST /me/nexus-selections` accepts query and target href with
a 204 response. ordinary use makes no selection-learning request. there is no
history http endpoint or cloud-history import. migration 0326 removes the four
obsolete usage columns and two recency indexes while preserving ranking rows.
