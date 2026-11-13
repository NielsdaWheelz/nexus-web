# mobile ask librarian has no new-pane action

the floating nexus workspace sheet exposes ordinary “ask librarian” only as a
follow action. touch users cannot open it in a new pane while preserving their
current pane. observed on the deployed phone interface at `9b435d881b371d6bc5f7323bfe60c5e322ff3834`
on 2026-11-12; the workaround was to fork a resource row, then ask librarian.

reproduce with no text selected: open the floating nexus sheet and inspect the
“ask librarian” command. `apps/web/src/lib/nexus/rows.ts:93` builds this command
without a secondary action. `components/switchboard/SwitchboardTask.tsx:175`
exposes the touch verb rail only for a target-menu secondary action, although
`components/nexus/NexusRow.tsx:137` already supplies a new-pane verb. the reader
selection action separately forks correctly and is outside this issue.

resolve by exposing a consistent touch action for opening this command in a new
pane. verify on the phone that it creates one librarian pane and preserves the
original pane, draft and reading position. outside the librarian latency repair.
