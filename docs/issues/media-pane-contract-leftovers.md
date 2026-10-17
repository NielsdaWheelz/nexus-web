# the media pane still reads three facts the media core no longer needs

**problem**: the media core slice (design Q3 (a)) kept the pane-facing interface
source-identical because `MediaPaneBody.tsx` is #578's (pane controls, merged as
`fa62a6901`) and the reader slices'. three leftovers stay until that file's owner drops
them:
`CapabilitiesOut.can_retry` on the wire, which nothing reads since the imports slice
deleted `mediaErrorMessage`'s unrendered `Retry` arm; the `capabilities` input that fed it;
and the id check in `mediaDetailFromResponse` (the pane passes the id it asked for).

**impact**: none visible: one boolean on every detail and stream frame, a dead code
path, and a check of our own response.

**evidence**: `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:374`
(`capabilities: { can_retry: … }`), `:102-105` and `:163` (`mediaDetailFromResponse(…,
id)`); `apps/web/src/lib/media/mediaErrorMessage.ts` (the unread input);
`apps/web/src/components/media/MediaInfoOverlay.tsx` (passes `media.capabilities`);
`python/nexus/services/media.py::_capabilities` (`can_retry`).

**resolved when** MediaPaneBody drops line 374 and the second argument at `:102-105`
and `:163`; `mediaErrorMessage` drops `capabilities`; `mediaDetailFromResponse` takes the response alone; `CapabilitiesOut` is
`{can_read, can_highlight, can_quote}` (gen:wire). rendering a Retry would be a
behaviour addition and is not this work.
