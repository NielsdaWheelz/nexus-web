# podcast show notes repeat accessibility ids

status: open
origin: 2026-10-16 principal-action implementation planning
area: web / podcast episode rows

`apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeList.tsx:116`
and `:126` derive the disclosure target solely from the episode id:
`episode-panel-${episode.id}`. two mounted panes for the same podcast therefore
publish duplicate ids when the same episode's panel is open. a disclosure can
name the other pane's panel. this is source-derived, not browser-verified.

prerequisite: preserve episode identity and each pane's independent expansion.
prefix panel ids with a per-mounted-list `useId()` value; publish
`aria-controls` only for the actual mounted region. no shared expansion store.

acceptance: open the same podcast in two panes and expand the same episode in
both. each disclosure names exactly one region in its own pane, both remain
independent, and moving show notes below a promoted playback control preserves
keyboard operation and return focus.
