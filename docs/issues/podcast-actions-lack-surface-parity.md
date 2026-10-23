# podcast actions lack surface parity

source review, 2026-10-23, `9b6d3a424`; no rendered verification.

podcast shows lack the shared subscription/libraries shortcuts requested for
index rows, pane title headers and resource menus. the canonical subscription
verb already exists; the missing behavior is not a blanket rename.

evidence:
- `apps/web/src/lib/actions/catalog.ts:142-143` and
  `lib/actions/project.tsx:195-221` already own subscribe/unsubscribe.
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx:396-399`
  publishes subscription alone; `:475-476` puts libraries in a body card.
- `apps/web/src/lib/collections/presenters/podcast.ts:17-39` exposes a resource
  menu reference but no inline action facts; `components/resources/ResourceIndexRow.tsx:53-56`
  promotes only media actions.
- `python/nexus/services/resource_items/actions.py:213-225` offers no podcast
  libraries command. existing `LibraryPlacement` dispatch in
  `apps/web/src/lib/actions/project.tsx:445-453` assumes a media id.
- `apps/web/src/components/podcasts/PodcastDestinationChooser.tsx:42-57`
  supports adding destinations only; subscribed destinations cannot open removal.

library-card slice implemented separately on `codex/library-podcast-card`,
baseline `459efb582`, 2026-10-23:
`components/podcasts/LibraryPodcastsSection.tsx` shares the native browse plus
from `lib/podcasts/navigation.tsx`, promotes global unsubscribe only in all,
and promotes local minus removal in named libraries. local occurrence and
canonical global menu entries remain distinct. at row content width <=479px,
the shortcut moves into more. routine copy and empty panels are removed;
warnings, imports and read failures remain. both reciprocal cards reuse local
removal and capture displayed successors when selected for acknowledged-success
focus. podcast browse no longer propagates an implicit library destination.

the broader action branch must adapt this approved card policy once onto its
general owners, preserving scope, menu completeness and focus without duplicate
projectors or presenters. standalone card qualification does not qualify that
combined change or close this broader issue.

resolve through shared podcast action projection and presentation, using existing
subscription command ownership and dialogs. reuse authoritative list/detail
facts; where missing, use a bounded local batch read owned by the containing
view, never per-row action fetches or directory calls. live index owners must
explicitly supply action subjects; captured evidence stays unchanged.
libraries must manage subscription destinations; it must not pass show
ids into media placement. preserve separate one-off import and episode cleanup.
name collection navigation `browse podcasts` rather than a show-specific verb.

resolved when stored/discovery index rows, show headers and complete menus share
the same commands, scope and state; narrow presentation follows the agreed compact
policy; keyboard/touch/focus, uncertain writes and cross-surface refresh are
qualified. update the existing release record for any wire-union change.
