# browser reader settings revert after reload

the browser's durable account binding retains its original reader profile after
acknowledged settings edits. after reload, the api can report the dark reader
theme while the actual reader frame retains `data-theme="light"`.

reproduction: change reader settings through the normal settings pane; observe
`PATCH /api/me/reader-profile` and a matching subsequent get; reload a media page.
observed during reader-map qualification in firefox, 2026-10-28.

evidence: `apps/web/src/lib/authored/BrowserWorkspace.tsx:34-47` reads the saved
binding and fetches a profile only when absent;
`apps/web/src/lib/authored/binding.ts:30-33` writes an initial binding only;
`apps/web/src/lib/native/settingsRefresh.tsx:13` returns immediately for browsers
after settings saves.

resolved when acknowledged reader settings survive browser reload and offline
reopening through the existing durable binding owner, without direct storage
mutation or an independent profile writer.
