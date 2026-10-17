# singular tab count label

origin: wire-10 browser qualification, `632c88e30197007df99b2421a424809228d0faa0`

the mobile workspace button announces “all 1 tabs” when one tab remains.
`apps/web/src/components/switchboard/SwitchboardTask.tsx:163` always uses the
plural in its accessible label. visible “all tabs · 1” is unaffected.

use singular “all 1 tab” for one pane. verify the accessible names at one and
two panes, including after closing the final pane. no release blocker.
