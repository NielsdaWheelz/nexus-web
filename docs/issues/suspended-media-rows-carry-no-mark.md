# a suspended work's index row carries no mark

status: open · origin: 2026-11-12 imports register review at `858cb192e` · area: collection rows

source-derived; no live reproduction.

a work with nothing readable whose source job is dead reads `suspended`, not
`failed` (`python/nexus/services/media.py:209`). index rows paint their `!` and
say `couldn’t process this. see its metadata.` only for `failed`
(`apps/web/src/components/collections/CollectionRow.tsx:86`,
`apps/web/src/components/resources/ResourceIndexRow.tsx:119`). the media pane and
its metadata overlay do word the suspended state
(`apps/web/src/lib/media/mediaErrorMessage.ts:37`).

impact: in a library a stopped, unreadable import looks like any other row until
it is opened. the imports pane exposes the stopped job, but the collection row
does not carry that distinction.

fix, afaict: let the two row presenters mark `suspended` as they mark `failed`,
with words that are true of a stopped job.

resolved when: a library row for a work whose source job is dead and which has
nothing readable carries the row attention mark and a true description.
