# compact preview paragraph clamp

a two-paragraph literal can spend its second preview line on the paragraph
separator and clipping ellipsis. content, accessible identity and match ranges
remain intact; the explicit excerpt dialog shows the full paragraphs.

observed in firefox and chromium at `a7098adfd`, disposable runs
`20261028-202717-623d485f09d8` and `20261028-204720-8a4e0198303a`.
`apps/web/src/components/nexus/Nexus.module.css:86` preserves whitespace and
clamps primary bodies to two lines; `NexusRow.tsx:35` preserves the capture's
literal paragraph separators. search a two-paragraph capture by its prefix and
inspect the compact primary on desktop or mobile.

choose a compact paragraph presentation before changing it. any normalization
must preserve literal evidence offsets and accessible identity; increasing row
height merely to expose the second paragraph defeats the compact bound. resolved
when the agreed presentation avoids an ellipsis-only line and full disclosure,
inline matches and paragraph boundaries remain correct.
