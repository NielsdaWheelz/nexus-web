# nexus performance marks have no reader but are held

status: open · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web) · area: nexus / pane runtime / openables

`apps/web/src/lib/nexus/performance.ts` (191 lines) writes User Timing measures
`nexus-open`, `nexus-local-find`, `nexus-pane-activate` and `nexus-openables`.
nothing reads them: no `PerformanceObserver`, no `getEntriesBy*`, no benchmark
or p95 gate (the app-navigation paragraph that claimed one is gone). after the
launcher rewrite nothing in the Nexus begins a measure either; the module stays
only because three modules outside the slice import it:

- `apps/web/src/components/workspace/PaneShell.tsx` (`NexusPanePerformanceContext`)
- `apps/web/src/lib/panes/paneRenderRegistry.tsx` (`useReportNexusPaneReady`)
- `apps/web/src/lib/resources/openableResources.ts` (begin/mark/cancel around the openables POST)

impact: 191 lines plus about 30 in those importers of telemetry with no reader.

fix: delete the module and the call sites in the three importers.

resolved when: `rg "nexus/performance" apps/web/src` finds nothing.
