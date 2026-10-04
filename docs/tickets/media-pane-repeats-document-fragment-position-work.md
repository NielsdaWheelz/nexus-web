# media pane repeats document fragment position work

status: open. origin: 2026-10-04 frontend source audit at `58ba9d45`; area: hosted reader pane. priority: p3.

`MediaPaneBody.tsx:1715–1855` independently sorts, scans and sums epub/web fragments for start, total, final unit and overview data. `readerDocumentPosition.ts:46–118` already builds ordered fragment offsets and total length from navigation, and the pane consumes that structure at `MediaPaneBody.tsx:1438`. this is duplicated representation/work, not a verified user-visible defect or measured cost.

first establish whether web content fragments can precede or disagree with navigation: the current web offset reads content fragments while overview reads navigation. then reuse the existing structure for values it actually owns; keep transcript/pdf and load/empty behavior distinct. acceptance: identical first/last positions, endcap, overview/ribbon, restore, section navigation and find preview across one real multi-fragment web article and epub, with a proportional transcript/pdf check.
