# the first pane warm delays the nexus active-row commit

status: open · origin: 2026-09-28 nexus launcher rewrite review (size/nexus-launcher-web) · area: nexus / pane warm

moving the Nexus active row onto a row that warms its pane (`setActive` in
`apps/web/src/components/nexus/useNexusController.ts` calls `usePaneWarm()` for places,
recents, openables and search rows) commits the new active row about 60 ms late the first
time a pane kind is warmed in a session; later moves commit in the same task. an Enter
pressed inside that window activates the previous row. the old controller warmed the same
rows, so this predates the rewrite; the cause (something `preloadPane` →
`loadPaneModule` sets off on a first chunk import) is not isolated.

evidence: live harness 2026-09-28 (production build, React 19.2): ArrowDown from a page
search row to the next page row, measured with a MutationObserver on
`aria-activedescendant`, committed after 59 ms on the first move and within the keydown's
microtask on the next five.

fix: find what delays the commit on a first `preloadPane`, or defer the warm past the
commit (for example schedule it after the state update lands).

resolved when: the first ArrowDown onto a warmed row commits within the keydown's task.
