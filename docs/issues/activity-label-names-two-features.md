# activity names both recovery and reading statistics

problem: the same label denotes unrelated capabilities, making the ubiquitous
workspace recovery tray look like reading statistics.

evidence: `apps/web/src/components/feedback/Activity.tsx:46-63,99-101` labels
current conditions and undo offers "activity".
`apps/web/src/app/(authenticated)/media/[id]/chrome.tsx:93-99` labels a `/stats`
link "Activity". `apps/web/src/components/appnav/AccountMenu.tsx:164-167`
already exposes that statistics destination under account.

impact: users cannot infer which feature opens; the reader menu also duplicates
an account-wide destination among contextual reader commands.

proposed fix: keep reading/listening statistics under account with one explicit
statistics label; remove the reader shortcut. retire the separate recovery tray
and its activity commands as described in
`activity-entrypoints-obscure-navigation.md`. do not merge operational feedback
with consumption statistics.

resolved when no visible label maps to both features and statistics remain
reachable from account. review only; no runtime change made.
