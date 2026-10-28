# two obsolete media detail contract fields remain

**problem**: the media core slice (design Q3 (a)) kept the pane-facing interface
source-identical because `MediaPaneBody.tsx` is #578's (pane controls, merged as
`fa62a6901`) and the reader slices'. two leftovers stay until that file's owner drops
them:
`CapabilitiesOut.can_retry` on the wire, which nothing reads since the imports slice
deleted `mediaErrorMessage`'s unrendered `Retry` arm;
and the id check in `mediaDetailFromResponse` (the pane passes the id it asked for).

browser recovery removed the unused `mediaErrorMessage.capabilities` input and
its callers while deleting the obsolete error-to-action presentation.

**impact**: none visible: one boolean on every detail and stream frame, and a
check of our own response.

**evidence**: `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
(`mediaDetailFromResponse(…, id)`);
`python/nexus/services/media.py::_capabilities` (`can_retry`).

**resolved when** `mediaDetailFromResponse` takes the response alone; `CapabilitiesOut` is
`{can_read, can_highlight, can_quote}` (gen:wire). rendering a Retry would be a
behaviour addition and is not this work.
