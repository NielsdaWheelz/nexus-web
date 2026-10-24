# dossier removal release

candidate implemented; operational cutover pending. owner approved deletion of all
dossier-owned content, including
instructions, and dossier references/previews; surrounding prose survives.
no conversion/export feature. owner also approved resetting ALL navigation on
each installed device through the old app, preserving writing and other data.
data cutover: [migration 0314](../../migrations/alembic/versions/0314_remove_dossiers.py).
retained behavior: [resource inspector and media intelligence](../architecture.md#78-resource-inspector-and-media-intelligence).

base: `2705809b1`, 2026-10-23; candidate head `0314`, wire `15`. recheck actual
release ancestry and the once-per-release wire rule. production/device state
has not been inspected; unused does not mean empty.

release steps:

1. inventory exact affected ids/counts against the approved loss contract:
   heads/builds/ideas, instructions, both resource schemes including historical
   revision refs, graph/view/version/authored-link facts, note bodies, chat
   scopes/context/retrievals/citations, jobs/generations/leases, workspace state
   launcher recents and accepted research attempts. unknown affected shapes or losses outside
   the contract block mutation. retain content privately, not in issue logs.
2. prepare EVERY installed device while the old app still works. settle
   unrelated drafts, sealed/uncertain writes and pending delivery through their
   existing owners; unresolved work blocks the cutover, never authorizes a
   storage wipe. then close every original pane, including minimized panes,
   through normal workspace commands. closing the last creates one fresh
   `/lectern` pane with empty history and no secondary. simply navigating an
   existing pane is insufficient. let native saving and the cloud mirror finish;
   restart the old app and prove that sole pane returned. independently read
   the same device's server row and confirm matching state. stop old clients
   after this check. this deliberately loses device navigation, not writing,
   account binding, downloads, playback state or activity delivery.
3. drain/cancel affected nonterminal chats through their existing owner. stop
   api/workers and any other writer through the release controller; prove they
   stopped, not just that a signal was sent. retain a verified backup of this
   quiescent database and matching build; rehearse restoration and the populated
   migration before production. separately preserve recovery access to any
   local writing. no new dossier export or maintenance endpoint is required.
4. apply the one forward migration. preserve accepted research media/holdings
   and source jobs; their pending/retried processing now uses ordinary embed
   extraction. settle dossier execution, remove approved references, migrate
   server layouts and drop owned schema. verify exact head and database
   postconditions before new writers start. rollback restores matching backup
   and code; no lossy downgrade.
5. publish aligned api, workers, web and installed bundles; align extension wire
   where required by the actual release bump. no mixed-version compatibility
   window. old clients receive existing wire refusal; do not reconnect an
   unprepared installed device. restart the prepared devices under the paired
   release and verify the retained fresh local/server layout.
6. qualify removed routes/actions and retained inspector/chat/search/note/
   citation/ingest/media-intelligence flows. record static, disposable runtime,
   live-provider, installed-device and production evidence separately in the pr.

why preparation is necessary: server workspace reads validate strictly
(`services/workspace_sessions.py:30-36`); android bootstrap keeps previous local
workspace (`DeviceSession.kt:316-317`). ordinary last-pane closure creates fresh
state (`apps/web/src/lib/workspace/store.tsx:148-161`); recently closed panes are
memory-only. a debounce completing or an absent warning is not durable proof.

removing dossier heads removes their page/note retention
(`resource_graph/retention.py:187-188`); inventory those subjects and disclose
later ordinary cleanup eligibility. do not delete them during migration.
closed generation usage/audit remains historical; media intelligence still
feeds connection discovery (`services/connection_discovery.py:314-318`).

resolved when the approved candidate passes static and focused populated/runtime
qualification, every affected device is prepared and accepts the paired release,
and production postconditions are observed. delete dossier-only defect records
after removal; retain shared media-projection recovery concerns. production and installed-device qualification remains `NOT_RUN`; candidate proof
and limits belong in the pr.
