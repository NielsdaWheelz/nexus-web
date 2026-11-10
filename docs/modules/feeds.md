# feeds

a feed is a source, a subscription is an ongoing delivery rule, and an import is
a finite acquisition. entries point to ordinary media. read state, physical library
membership, source coverage and acquisition progress remain independent facts.
podcast audio behavior lives in [podcasts](podcast.md); articles use the existing
article reader and source-attempt owner.

## identity and authority

`feeds/catalog.py` resolves explicit urls and podcast-directory identities without
creating holdings. normalized retrieval aliases identify one source; meaningful
path case and query parameters remain. redirects and declared aliases use the same
identity owner. mixed sources require an explicit article/podcast choice. public
directory resolution remains podcast-only.

`feed_entries` binds source-local observations to canonical media. guid/atom ids
belong to that source. exact canonical article urls may reuse readable media;
titles, dates and semantic similarity never merge entries. multiple sources may
refer to one article without duplicate library placements. publication precision
and publisher evidence remain explicit; first observation is not publication time.

podcasts retain `podcast:<id>` and `/podcasts/<id>`. article sources use `feed:<id>`
and `/feeds/<id>`. article-source visibility comes from supplying the source or a
current member-library source operation. ordinary article ownership grants no
source authority. raw retrieval urls require supplying-account or writable-source
authority. resource previews, actions and offline metadata use the same gate.
episode source links contain publisher permalinks, never retrieval feed urls;
only actual audio enclosures confer playback capability.

source authority grants only the active body's exact successful feed/entry lineage.
it never reveals a richer private capture sharing the canonical url. automatic
delivery checks every destination member's article authority before placement.
pending entries may open their own authorized source attempt without a holding.

## acquisition and removal

`feeds/subscriptions.py` owns subscription admission and reviewed stop commands;
`imports.py` owns finite operation lifetime. `queries.py` owns relationship reads
and guards. the [library writer](library.md) owns every physical placement.

subscribing in all targets the actual default-library uuid. subscribing in a named
library targets only that library; all sees its union. the shared destination review
offers available history plus future delivery, or available history once. choosing
or cancelling a destination creates neither relationship. an acknowledged empty
library survives cancellation.

admission atomically installs the rule/import, files known eligible entries and
queues remaining history. exact-id replay returns the existing operation without
recopying. additions compare the account removal fence; actual insertions alone
advance library order. an unfinished once import must finish or be cancelled before
subscribing. once admission refuses an already subscribed destination.

admission responses name their finite import `operation`; a library/source
relationship uses the same field, explicitly null when none is unfinished.
rest and model tools serialize that exact field name without aliases.

unsubscribe keeps entries by default. explicit cleanup freezes its complete
destination set, rule/import identities and attempts; removing placements also
freezes each affected library's order revision. read-only destinations block the
whole reviewed change. independent imports are excluded from keep-only unsubscribe.
overlapping active rules also block the whole cleanup; both source and entry reviews
name each protecting source and its displayed destination from the same preview.
cancel keeps accepted arrivals. retry retains processed identities and resumes
the owned cursor; it never silently restarts an acknowledged acquisition.

source-retained articles and episodes use `feed-entries/{media_id}` removal review.
every contributing rule and unfinished import participates, including overlapping
sources. active subscriptions block removal. cleanup retains media identity,
notes, highlights, consumption, lectern and downloads, and writes no hiding marker.
generic destructive media deletion does not own these entries.

## traversal and publication

`feeds/traversal.py` fetches one bounded page per durable job. fetch happens outside
the publication transaction; identities, eligible delivery, counts, cursor and
next work commit together behind exact run/attempt/step/job fences. publisher
withdrawal does not delete known entries. coverage gaps survive successful later
pages; known counts never imply complete publisher history.

`sync.py` separates a short head check from catch-up history. current headlines
therefore do not wait for a long archive walk. current subscriptions decide delivery
at publication; unsubscribe fences future placement. remaining rules schedule the
next hourly check with bounded failure backoff. detail opening can admit one source
check per live visit; previews, action facts and passive list reads cannot.

article observations enter ordinary source attempts. feed content and summary
extent remain explicit; a complete existing body is not replaced by an excerpt.
newer bodies from the same entry supersede older attempts through the existing
publication fence. another in-flight source keeps its authority; the unconsumed
feed observation remains eligible for a later check. source fingerprints advance
only after admission or deliberate retention of an authoritative publication.
linked extraction is admitted only for an explicitly opened article or a bounded
daily nomination. the ordinary admission owner retains uncertainty and recovery.
after a failed linked fetch, an authorized source reader can deliberately refresh
through the existing action unless the source error is terminal. reopening does
not retry automatically; stored-artifact repair remains the creator's operation.
source lists never fetch every linked page or request transcripts/audio/model work.

## interface and observation

podcasts and feeds are two instances of `LibraryFeedsSection`, `FeedsPaneBody` and
`FeedDetailPaneBody`. the cards, menus, glyphs, destination chooser and stop reviews
share their owners. read-only libraries keep browse access; they grant no writes.
all has no local unsubscribe shortcut. named shortcuts act on the named destination.

`presentFeed` projects source rows from supplied facts; it performs no detail fetch.
the subscription glyph means last-observed recurring delivery somewhere, never
feed health or completed history. failed reads retain disabled observations and
authorize no command. a known canonical source and observed subscription can open
its review during ordinary revalidation; the review's fresh guards still admit
every write. cold, unknown and failed facts remain blocked. source-state wire values are `unread | in_progress | finished`;
podcast controls retain their existing played/unplayed wording.

source entries use bounded keyset pages with explicit load-more. local text filtering
reports matches among the loaded prefix; catalogue counts remain whole-source facts.
refresh replaces the loaded prefix. pages are live ordered observations, not a frozen
archive snapshot. a visible observation lane follows source/import/transcript work;
hidden panes initiate no polling. [offline catalogue](offline-catalog.md) supplies
complete saved metadata without bodies, new authority or offline source writes.

`lib/feeds/commands.tsx` freezes request bytes and client ids before admission.
unknown outcomes keep exact replay and loss guards after presentation closes;
observations cannot acknowledge a command. accepted history progress describes
committed additions and already-present items, with no invented denominator.

## opml

the existing intake accepts opml files. preview is a bounded parse (1 mib, at most
1000 rows), with no source fetch or write. review exposes invalid and duplicate
rows, optional source-kind choices and flat destination mappings. folder paths
never create a hierarchy. the shared library chooser owns destination creation.

confirmation freezes one client-id batch, child ids, normalized urls, kinds and
destination ids. server acknowledgement means the batch is durable after close;
unacknowledged bytes remain the command owner's responsibility. the worker resolves
and admits children independently, retaining unresolved rows and exact retry/cancel
guards. cancellation preserves accepted subscriptions and their admitted history.

fresh review first requires explicit cancellation of the previous unresolved plan.
the same review dialog carries forward only failed/cancelled rows, preserving their
source-kind choices and destinations that remain writable. unavailable destinations
require an explicit choice. confirmation uses fresh authority/removal facts and new
batch/child ids; accepted children remain untouched. retry preserves original bytes.

`/feed-opml-imports` supplies all active/attention batches plus bounded recent
terminal summaries to the existing imports surface. disclosure reads child details;
the existing imports observation clock owns refresh. export includes active
subscriptions only and retains the source owner's retrieval-url privacy gate.
