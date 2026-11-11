# work and consumption activity presentation

status: deferred to a later change by the owner on 2026-11-10. implement the
authored task/habit loop before consolidating it with reading/activity tracking.

problem: daily work and consumption could share date navigation, heatmaps or a
retrospective surface, but their facts and correction rules differ.

evidence at `71bee9b5a`: `docs/modules/consumption-activity.md:14-29` owns observed
duration and the first canonical media completion. ordinary unread/reset keeps
that completion; exact undo may remove it. the owner chose task reopening to
remove its completion from the journal. `StatsPaneBody.tsx:319-350` under
`apps/web/src/app/(authenticated)/stats/` contains an inline read-only duration
heatmap, not an existing shared interactive habit calendar.

impact: prematurely unifying writers or history would erase provenance or give
one product the other's correction semantics. a habit check supplies no duration.

future pickup: inventory the then-existing presenters. share a small date/grid
component if both concrete consumers benefit; preserve each capability's write
owner, units, eligible dates and correction rules. combine reads only where the
display names the distinct facts and makes completeness explicit.

resolved when the chosen shared surface presents both kinds of facts faithfully,
habit correction does not rewrite observed consumption, and any shared component
reduces duplicated behavior without creating a generalized activity framework.
