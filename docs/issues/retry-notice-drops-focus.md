# a first-load Retry drops keyboard focus

**problem**: `useServerValue` clears a first load's error when Retry refetches ("a retried
first load shows progress again, not its last failure", `lib/api/serverState.tsx` `run`),
so the failure notice unmounts with the focused Retry button in it and focus falls to the
body. the atlas pane moves focus to its headline itself; every other first-load Retry
still drops it: settings identities and account, the library pane and its settings
dialog, the podcast head, the podcasts pane's libraries, the lectern and every
suggestions section (quick reads, lectern, library), imports list and inspector.

**impact**: small. a keyboard or screen-reader user loses their place after Retry and
starts again from the top of the page.

**evidence**: `onClick: <value>.refetch` on a notice shown only while `status ===
"failed"` (`git grep -n 'onClick: [a-zA-Z]*\.refetch' apps/web/src`); review of the atlas
slice (finding 5).

**resolved when**: Retry on a failed first load leaves focus on a mounted element in each
pane above. one change to the shared contract (the notice stays mounted while it retries)
would cover them all.
