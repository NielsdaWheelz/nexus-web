# invalid-view Reset view drops focus to the body

status: open
origin: 2026-10-14 review of the cleanup stack's #578 absorption (finding 3); live run on 62c06aeff
area: web / pane controls

Reset view on an invalid-view notice unmounts its own button. These panes then
leave focus on `<body>`:

- `conversations/ConversationsPaneBody.tsx` `reset` (#578): `usePaneUrlState`
  replaces with the codec's collection-reflow transition. `startViewTransition`
  (`lib/ui/viewTransitions.ts`) runs that update after the
  `requestAnimationFrame` that focuses "Filter chats", so the input is not
  mounted yet. With prefers-reduced-motion: reduce there is no transition, and
  focus lands on the input.
- `authors/[handle]/AuthorPaneBody.tsx` `resetView`: the same rAF focus after a
  collection-reflow replace. Afaict from source; not driven.
- `podcasts/PodcastsPaneBody.tsx` and the episodes notice in
  `podcasts/[podcastId]/PodcastDetailPaneBody.tsx`: the recovery replaces the
  url and focuses nothing.

evidence: absorb review `2026-10-14/absorb/review/grammar2/invalid.json`
(62c06aeff, chromium 1280). After Reset view, conversations, podcasts and podcast
report focus `BODY`.

fix: a recovery is not a reflow. Replace without the transition, then focus the
pane's query input. Library detail, the libraries index and the notes index
already do this.

acceptance: on each pane, load an invalid view (`?sort=bogus`; podcast episodes
likewise), press Reset view with motion allowed, and focus is on the pane's
query input.
