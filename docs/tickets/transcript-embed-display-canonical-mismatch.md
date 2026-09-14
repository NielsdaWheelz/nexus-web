status: open
origin: 2026-09-13 bounded workspace implementation
area: transcript reader / document embeds

`apps/web/src/lib/media/documentEmbeds.ts::renderDocumentEmbedsInHtml` replaces authored embed placeholders with current title/status/action text. the transcript branch of `MediaPaneBody.tsx::textReaderDecorator` uses that output; its canonical cursor includes every rendered descendant. live card text can therefore disagree with the transcript's stored canonical text and disable or misplace selection/progress mapping. publication units now preserve authored nodes and keep an exact source cursor before adding live card ui; the transcript branch still uses the old replacement owner.

prerequisite: audit existing transcript embed source/locator fixtures and authored text contract. reuse the direct card builder and explicit source/ui projection; do not silently exclude authored text or synthesize offsets. also route transcript card thumbnails through the existing artwork owner instead of raw img.src.

acceptance: real transcript source with mutable embed title and thumbnail preserves authored canonical offsets, selection, highlight and progress; card activation still works; image demand uses the shared visible artwork lease. demonstrate failure under the old replacement behavior.
