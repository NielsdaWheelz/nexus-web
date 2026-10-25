# the current pane has two names

problem: the desktop strip tells a screen reader the active chip is "Active
pane." while nexus rows and the manage-panes list call the same pane
"current". both also set `aria-current="page"`, so the strip says it twice in
two vocabularies.

impact: one fact, two names, depending on where focus is. a screen-reader user
moving from the strip to nexus hears the state renamed.

evidence at branch `fork-gesture-pane-noun` (base `4a5b1c710`):
`apps/web/src/components/workspace/WorkspacePaneStrip.tsx:127` ("Active pane.")
beside `:112` (`aria-current`); `apps/web/src/lib/nexus/rows.ts:111`
(`paneState` → "Current"), rendered by `rowFacts` (`:611-620`);
`apps/web/src/components/nexus/NexusPages.tsx:57-58` and `:87` (manage-panes
state line).

proposed fix: pick one word. "current" matches `aria-current` and nexus; the
strip can drop its sr-only text and rely on `aria-current`, or say
"Current." like its "Minimized." and "Maximized." siblings.

resolved when the strip, nexus rows and manage panes announce the active pane
with one word, once.
