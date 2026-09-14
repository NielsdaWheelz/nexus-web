status: open
origin: 2026-09-14 bounded reader source-table browser integration
area: authored table sanitization / publication context

actual publisher artifact `source-table-schema-2-members.json` (sha256
`4af6dce5cd5b557b5f53bf5a2708ed6b9b4f8e3b97a09c1169e9257cb821abea`,
member graph verified in `ee367cda82cca3b7`) loses the service fixture's authored
`<caption id="caption">late caption</caption>`. table metadata has
`caption:null`; final unit `2214-2299-0.json` emits the words as a bare text child
of tbody. the splitter kernel preserves the same caption, so audit the actual
web sanitizer before changing the publication table owner.

the safe caption tag is now preserved. actual source red
`8f6f3c370237c003` becomes green `24d947b70dabea09`: exact caption range/unit,
rendered caption element, original source bytes and closed archive agree.
the new member artifact has sha256
`d0ae33c2a0eea0a2aa219354b19b8197e037da7bd9c577a6b51f430da02e5184`.
the browser corpus remains frozen pending its coordinated replacement.

web source preparation already removes general authored ids; this correction
does not broaden that policy. the caption's exact structural source range is
its retained address. do not fabricate an id or caption context from bare text.

acceptance: replay the actual regenerated members through the bounded reader;
caption context reaches those exact words and preserves table accessibility.
