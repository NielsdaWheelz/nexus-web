# highlight rows outside the open source read their excerpt twice

status: open; source audit, not measured.

a highlight row placed in its open source opens two authored subscriptions. any other
highlight row opens four:

- `{kind:"excerpt"}` in `LocalRow`: `apps/web/src/components/resources/ResourceOutlineRow.tsx:131`
- the identical query again in `useFullExcerpt`: `apps/web/src/components/resources/ExcerptDisclosure.tsx:29`
- `{kind:"resource"}` for the source label: `ResourceOutlineRow.tsx:216`
- `{kind:"resource"}` in `apps/web/src/components/notes/HighlightAnnotation.tsx:35`

`useAuthoredQuery` subscribes once per hook (`apps/web/src/lib/notes/hooks.ts:29`).
store-side dedupe was not checked. the duplicate is costly in contained readings,
where `excerptQuery` pages intervals and quote windows
(`node/authored/src/queries.ts:472-507`). remote passage rows outside the source also
issue one full `/resource-items` GET each (`ExcerptDisclosure.tsx:42`).

impact: per-row cost on large books, for unplaced rows and on other surfaces.
`OutlineEditorRow` still needs `FullResourceBody`, so the row can't simply reuse its
own read everywhere. related: [large reader connections](large-reader-connections-blocks-ui.md).

resolved when a mounted highlight row opens one excerpt read, proved by a subscription
count on a representative book.
