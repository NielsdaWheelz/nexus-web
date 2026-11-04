# native back callback stays disabled after task backgrounding

`apps/android/app/src/main/java/app/nexus/android/MainActivity.kt:360-361,371-372`
disables its sole back callback before delegating the no-history action.
`onNewIntent` and `onResume` do not restore it. both disabling branches occur
at feedback source `cd7d935bb` and its main baseline `3ba73e379`.

a launcher-root activity can survive system back as a background task. if that
same activity resumes, its disabled callback can bypass escape, history handling
and pending-work protection. source establishes the risk; this build has not
qualified the no-history → background → same-activity resume → back journey.

the import owner retains that real-navigation oracle and any repair at the
existing delegation owner. its integrated `b709a2fe` records the same issue;
no import repair is composed here. keep recursion prevention and stale-document
checks while restoring callback ownership after delegation returns.

resolve by proving ordinary no-history exit and later escape/work protection in
the same surviving activity, with the repair composed at the released source.
do not manufacture activity, history or controller state to qualify the behavior.
