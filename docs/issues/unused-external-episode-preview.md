# unused external episode preview

problem: external episode playback remains implemented, but current ui producers
resolve episodes into the catalogue before rendering playback controls. the
unused path duplicates playback presentation and cannot be qualified through
the real application.

evidence at `6d6a6799c95f6c9a5aa2ceed0edd9b12d44ccbf8`:

- `apps/web/src/app/(authenticated)/browse/preview/BrowsePreviewPaneBody.tsx:187`
  returns before the external media actions for episodes and podcasts; its
  external subject at line 244 admits only books, videos and web articles.
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx:126`
  constructs only external books; `apps/web/src/lib/collections/presenters/browse.ts:52`
  likewise constructs no external episode subject.
- `apps/web/src/lib/actions/useMediaActions.ts:88` still dispatches
  `playPreviewAudio` for an external episode subject.

owner decision, 2026-10-28: qualify reachable catalogue playback in the menu
presentation change; retire unused preview support separately. external preview
and replay remain unqualified, not a passed live check.

resolution: trace preview command/type/player/native dependants, remove the
unreachable path at its owners without compatibility arms, and verify actual
catalogue play, pause, resume and ended/replay. close when no unsupported external
episode producer or preview playback dependency remains.
reconcile [preview queue interruption](queue-append-interrupts-preview.md) during
that removal; its proposed repair assumes preview playback remains supported.
