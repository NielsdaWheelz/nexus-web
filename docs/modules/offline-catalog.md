# installed catalog

the android catalog is a complete, dated browsing projection. it contains personal
library memberships, followed and referenced shows with visible episodes, lectern
selections, and owned note/chat index summaries. it contains no bodies or downloaded
assets and authorizes no command. hosted reads keep their existing owners.

## server contract

`GET /offline-catalog` returns `Data[OfflineCatalogOut]` for the authenticated viewer;
the existing bff exposes `/api/offline-catalog`. query parameters are refused.
responses require the current wire revision and are private/no-store.

format 2 adds the positive decimal-string `consumption_revision`, each episode’s
raw `consumption` and nullable `source_duration_ms`, and each media’s raw nullable
`remaining_seconds`. source duration may change with feed metadata independently
of the consumption watermark; a stored listening duration of zero stays unknown.
text and listening remaining-time ordering use the same consumption projection
as live library entries. clients retain canonical title ranks for numeric ties.

one read-only repeatable-read transaction selects the complete projection. existing
domain owners supply visibility, membership, summaries and total-order plans.
postgres assigns named integer ranks; clients filter those ranks rather than
imitating database collation, null placement or tie directions. each library's
structural ranks have their own domain; media/episode ranks span their entity
tables, and followed-show ranks exclude detail-only shows.

the typed response validates identity uniqueness, reference closure, complete
orders, repeated facts and episode counts before serialization. snapshot identity
is opaque. capture time dates the database observation, not transfer completion.
there is no export table, server artifact, endpoint crawl or incremental protocol.

roots are non-system member libraries, active personal subscriptions/imports and
visible lectern selections. included shows admit their complete visible episode
selection, without fetching provider history. explicit lectern selections may
include system/grant-only media; they do not admit the surrounding corpus.
subscription sections and media memberships remain distinct relations.

## device contract

`CatalogStore` owns the original response bytes at `files/catalog/catalog.json`.
one acquisition streams to a private candidate, validates it off the main thread,
then publishes through `AtomicFile`. transport has a 120-second total deadline
and a 64-mib decoded limit; the generic origin response limit remains unchanged.
failure retains the last complete compatible snapshot. native validates strict
utf-8/json through eof, envelope identity, account, format and wire; the server
owns domain semantics. incompatible/corrupt bytes are explicit errors and remain
until a successful rebuild or explicit sign-out.

`DeviceSession` alone grants local account access. catalog validation never gates
the shell or hello. binding starts local validation on the existing io scope,
overlapping bundled startup; file/status reads await that validation. discovery
returns through those reads, while acquisition and retirement push changes.
a surviving catalog namespace constrains first provisioning
without granting access. account retirement cancels acquisition, closes registered
streams and prevents late publication; the existing sign-out tombstone owns purge.
ordinary replacement permits already-open readers to finish the older snapshot.

the fixed owned-origin `/_nexus/device/catalog.json` route requires the wire header
and returns the envelope, 204 for absence, or a typed local error. no arbitrary
path/account/url enters the bridge. `catalog_status` reads readiness;
`catalog_refresh` acknowledges starting/joining work promptly. terminal status
arrives through `catalog_changed`. a usable snapshot, active acquisition and last
error are independent facts; a failed refresh can retain a usable snapshot.

## web contract

one installed `CatalogProvider` owns account-scoped in-memory indexes, fixed-route
reads and refresh initiation. no catalog enters browser storage. subscribe before
opening the initial file, then read status after it settles. a newer push retires
older replies, and newer file/account generations retire local reads.

foreground/reconnect and manual refresh run when visible and remotely admitted,
on any connection. relevant change topics coalesce after 30 quiet seconds;
consumption heartbeats and note-body events are excluded. duplicate triggers join.
a due change during acquisition queues one follow-up after success. failure waits
for a new trigger; no hidden-page initiation, periodic polling or background job.
online writes never await this work. catalog adoption emits no ordinary changes.

shared read hooks carry an explicit live/catalog source. new covered queries paint
complete saved results, then stage a complete live reread before promotion.
catalog generations never share cursors or summary overlays. complete mounted live
results of consumption-independent views survive disconnection; new offline
queries use the saved snapshot. authoritative live errors retain their existing
meaning. saved summary callers bypass live media-summary resolution.

readers see the saved index projected over this device's listening facts
([player](player.md), `lib/consumption/listening.ts`) before filtering and sorting:
summaries, episode states, show unfinished/unplayed counts, `has_new`, remaining
seconds and lectern membership. unaffected rows keep their exact saved values.
remaining sorts compare raw seconds (missing last, then the canonical title rank);
the unplayed sort compares effective counts (then the recent-episode rank). the
raw snapshot's per-episode observations go to native for media it retains.

library heading/entries/subscriptions, podcast heading/episodes, the podcast
index and the lectern are consumption groups owned by their panes
(`useLiveGroup`). lost remote admission returns a covered group wholly to its
saved projection; afterwards it promotes only when every part is a complete live
read, no relevant (unfiltered saved membership) local delivery is pending, and
every part's stamped `consumption_revision` covers the highest relevant observed
revision, all checked against current facts at commit. a promoted connected group
stays live. live list pages each carry their stamp; a traversal covers its oldest.
`PaneChrome.displayTitle` belongs to the shown body, so an independently refreshed
workspace title cannot put a new heading above a saved group. navigation labels
retain their existing best-known presentation policy.

saved ordering/capabilities/revisions are historical. remote actions require
admission and fresh action facts. current local writing, downloaded media and
player operations retain their owners; catalog reads never rebase their commands.
notes retain existing pending/confirmed deletion suppression, with counts computed
after that projection. no durable per-write catalog patches are made.

detail routes keep retained content first, otherwise show saved identity and a
truthful unavailable-body boundary. a summary never fabricates a media detail,
empty authored text or empty chat. unsupported ids/scopes are coverage outcomes.
workspace titles can use saved display metadata when no retained authoritative
presentation exists. local authored titles and authoritative absence retain their
precedence; saved titles never enter writing watches or version adoption.
the single device notice reports save/freshness/retry alongside higher-priority
auth/update recovery. artwork remains best effort.

full transfers, whole-file parsing and stale saved views are deliberate costs for
one complete publication contract. format/wire changes require an online rebuild;
there are no compatibility readers or alternate stores.
