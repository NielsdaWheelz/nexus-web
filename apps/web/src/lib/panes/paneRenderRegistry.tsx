"use client";

import { Suspense, useDeferredValue, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { ServerSeedsSpent } from "@/lib/api/serverState";
import { PaneModuleLoadError } from "@/lib/panes/PaneModuleLoadError";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";

type Module = { default: ComponentType };

// Bodies remain separate chunks; the shell owns their readiness. Server rendering
// and hydration suspend until code arrives, preserving streamed body markup.
const LOADERS: Record<PaneRouteId, () => Promise<Module>> = {
  downloads: () => import("@/app/(authenticated)/downloads/DownloadsPaneBody"),
  lectern: () => import("@/app/(authenticated)/lectern/LecternPaneBody"),
  libraries: () => import("@/app/(authenticated)/libraries/LibrariesPaneBody"),
  library: () => import("@/app/(authenticated)/libraries/[id]/LibraryPaneBody"),
  browse: () => import("@/app/(authenticated)/browse/BrowsePaneBody"),
  browsePreview: () =>
    import("@/app/(authenticated)/browse/preview/BrowsePreviewPaneBody"),
  media: () => import("@/app/(authenticated)/media/[id]/MediaPaneBody"),
  conversations: () =>
    import("@/app/(authenticated)/conversations/ConversationsPaneBody"),
  conversationNew: () => import("@/components/chat/Conversation"),
  conversation: () => import("@/components/chat/Conversation"),
  podcasts: () => import("@/app/(authenticated)/podcasts/PodcastsPaneBody"),
  podcastDetail: () =>
    import("@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody"),
  search: () => import("@/app/(authenticated)/search/SearchPaneBody"),
  author: () => import("@/app/(authenticated)/authors/[handle]/AuthorPaneBody"),
  notes: () => import("@/app/(authenticated)/notes/NotesPaneBody"),
  pageNew: () => import("@/app/(authenticated)/pages/[pageId]/PagePaneBody"),
  page: () => import("@/app/(authenticated)/pages/[pageId]/PagePaneBody"),
  dailyDate: () => import("@/app/(authenticated)/pages/[pageId]/PagePaneBody"),
  note: () => import("@/app/(authenticated)/notes/[blockId]/NotePaneBody"),
  imports: () => import("@/app/(authenticated)/imports/ImportsPaneBody"),
  stats: () => import("@/app/(authenticated)/stats/StatsPaneBody"),
  settings: () => import("@/app/(authenticated)/settings/SettingsPaneBody"),
  settingsAccount: () =>
    import("@/app/(authenticated)/settings/account/SettingsAccountPaneBody"),
  settingsReader: () =>
    import("@/app/(authenticated)/settings/reader/SettingsReaderPaneBody"),
  settingsAppearance: () =>
    import(
      "@/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody"
    ),
  settingsIdentities: () =>
    import(
      "@/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody"
    ),
  settingsKeybindings: () =>
    import("@/app/(authenticated)/settings/keybindings/KeybindingsPaneBody"),
  atlas: () => import("@/app/(authenticated)/atlas/GrandAtlasPaneBody"),
  oracle: () => import("@/app/(authenticated)/oracle/OracleLandingPaneBody"),
  oracleReading: () =>
    import("@/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody"),
};

type ModuleSnapshot =
  | { readonly kind: "Pending" }
  | { readonly kind: "Ready"; readonly Body: ComponentType }
  | { readonly kind: "Failed"; readonly error: PaneModuleLoadError };
interface ModuleEntry {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ModuleSnapshot;
  getServerSnapshot(): ModuleSnapshot;
}

// One import and terminal code outcome per route, without account or read data.
// Failures retain their stage and recover only through an explicit document reload.
const modules = new Map<PaneRouteId, ModuleEntry>();

function load(id: PaneRouteId): ModuleEntry {
  const loaded = modules.get(id);
  if (loaded) return loaded;
  let snapshot: ModuleSnapshot = { kind: "Pending" };
  const listeners = new Set<() => void>();
  const publish = (next: ModuleSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  // Both outcomes settle this same promise; failures are thrown from the cached
  // snapshot, so a retired consumer leaves no unhandled import rejection.
  const promise = LOADERS[id]().then(
    ({ default: Body }) => publish({ kind: "Ready", Body }),
    (error: unknown) => publish({ kind: "Failed", error: new PaneModuleLoadError(error) }),
  );
  const entry: ModuleEntry = {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot() {
      if (snapshot.kind === "Pending") throw promise;
      return snapshot;
    },
  };
  modules.set(id, entry);
  return entry;
}

function PaneBody({ id }: { readonly id: PaneRouteId }) {
  const entry = load(id);
  const current = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getServerSnapshot);
  // Client module arrival starts interruptible rendering, rather than a Suspense
  // retry's minimum fallback delay. No initial value: SSR must keep its ready body.
  const snapshot = useDeferredValue(current);
  if (current.kind === "Failed") throw current.error;
  if (snapshot.kind === "Pending") return <PaneLoadingState label="Loading pane…" announcement="None" />;
  if (snapshot.kind === "Failed") throw snapshot.error;
  const Body = snapshot.Body;
  return <><Body /><ServerSeedsSpent /></>;
}

export function renderPane(id: PaneRouteId): ReactNode {
  if (id === "pageNew") id = "page";
  return (
    <Suspense
      fallback={<PaneLoadingState label="Loading pane…" announcement="None" />}
    >
      <PaneBody key={id} id={id} />
    </Suspense>
  );
}
