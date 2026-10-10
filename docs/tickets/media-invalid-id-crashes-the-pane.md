# an invalid media id crashes its pane instead of rendering a pane state

status: open · origin: 2026-10-09 workspace harness baseline (J11.invalid-ref-is-pane-local-state) · area: media pane

`/media/not-a-uuid` shows "This pane couldn’t load", whose Retry cannot help:
the media chrome builds `canonicalResourceRef({ scheme: "media", id })`
(`apps/web/src/app/(authenticated)/media/[id]/chrome.tsx:242,289`) and
`assumeCanonicalResourceRef` throws `Invalid canonical ResourceRef`
(`apps/web/src/lib/sharing/targets.ts:10`). the route resolves (`media`) but
its resource locator is null.

impact: low. a malformed link shows a crash region instead of "not found".

fix: the media body treats a non-uuid id as not found before building refs.

resolved when: harness J11.invalid-ref-is-pane-local-state passes with its
xfail removed.
