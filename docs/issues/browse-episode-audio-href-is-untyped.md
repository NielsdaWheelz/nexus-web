# a browse episode preview's audio href is typed only as a string

status: open · origin: 2026-10-10 podcasts/browse web rewrite (spec D10) · area: browse / preview schema

`EpisodePreviewFacts.audio_href: str` (`python/nexus/schemas/browse.py:296`)
is a plain string. The preview pane reads the host with `new URL(audioHref)`
at render (`apps/web/src/app/(authenticated)/browse/preview/BrowsePreviewPaneBody.tsx`),
so a relative or malformed href would throw there. Unreachable today: the
Podcast Index adapter drops any episode whose enclosure is not an absolute
https url (`services/browse/podcast_index.py` `_episode`), and no other source
yields episode previews. The web keeps no defence (design T16).

fix: type the field at the schema as an absolute https url and regenerate the
wire; the web keeps reading it as given.

acceptance: the schema refuses a non-absolute audio href; `wire.gen.ts` carries
the narrower type; the preview has no client check.
