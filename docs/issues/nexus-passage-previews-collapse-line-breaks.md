# launcher passage previews collapse retained line breaks

problem: launcher row styling overrides the shared passage renderer's whitespace
contract, joining a quotation and context from different paragraphs.

evidence: source audit at `58e135bf2958bab8ca12971cb3984f77c01c2e66`,
2026-10-28; no browser reproduction. `apps/web/src/components/nexus/NexusRow.tsx:53`
places `ResourceBody` inside `rowLabel`.
`apps/web/src/components/nexus/Nexus.module.css:89` sets
`[data-resource-primary]` to `white-space: inherit`, overriding
`apps/web/src/components/resources/ResourceContent.module.css:8-10`'s
`white-space: pre-wrap`; line 97 also selects normal whitespace for inline evidence.

impact: even a correctly retained newline disappears on this surface. retain
compact-row density through explicit excerpt omission or disclosure, without
turning separate source paragraphs into one sentence.

resolved when launcher results with prefix/selection/suffix spanning paragraphs
preserve their breaks at desktop and mobile widths, including inline search
evidence. full source structure is separately tracked in
`highlight-excerpts-lose-source-structure.md`.
