# reader focus mode is a tablist without panels

status: open · origin: 2026-10-10 visual primitives reauthor (cleanup/visual-primitives-reauthor) · area: web / settings, reader

`app/(authenticated)/settings/reader/SettingsReaderPaneBody.tsx:126-142` renders
the Focus mode choice (Off, Distraction-free, Paragraph, Sentence) as
`Tabs`/`TabsList`/`TabsTrigger` with no `TabsContent`: a `role="tablist"` whose
tabs control nothing. selecting a tab writes `focus_mode`; nothing appears or
hides. screen readers announce tabs and expect a panel to follow.

by meaning it is a single choice among four values, a radio group (or a
segmented radio group styled like the tabs).

what to do: render it as a `role="radiogroup"` of radios (keeping the segmented
look and arrow-key selection), and keep `Tabs` for views that switch panels
(Imports).

resolved when: the focus mode control exposes `radiogroup`/`radio` roles with
`aria-checked`, arrow keys still move and select, and the visual harness journey
J6.tabs-arrow-keys-wrap-and-select is retargeted to it.
