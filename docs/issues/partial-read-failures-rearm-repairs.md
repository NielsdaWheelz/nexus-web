# partly failing reads can keep repairing one another

status: open
origin: 2026-11-01 feedback-homes L0a review
area: web / read layer

a success while admission is `Unavailable` raises a repair, and a read that fails on one
request but not another causes both halves: its status 0 publishes `Unavailable`, its success
restores `Ready`. one such read settles, because a read answers no repair while it runs. two
need not. their ladders end apart, so the later one's success repairs the earlier, whose
rerun repairs the later, and so on. a `Promise.all` load can do it alone: a sibling that
succeeds after the ladder settled repairs its own read.

impact: about three requests a second at the origin until the path recovers or a pane closes.
nothing paints. it needs status 0 on one path while another answers, at the same time, in two
reads or in one `Promise.all`, so it should be rare.

evidence, by reading, unrun: `apps/web/src/lib/api/client.ts` `observeRemoteSuccess` call;
`apps/web/src/lib/native/admission.ts` `setAdmission`; `apps/web/src/lib/api/serverState.tsx`
`owner.read` leaves a settled request's controller live;
`apps/web/src/components/podcasts/PodcastLibrariesOverlay.tsx:44`. the one-read loop this
descends from is fixed, with the lab case `a failing later page settles`.

resolved when: a read that answered a repair and failed again needs evidence from outside
itself before it answers another.
