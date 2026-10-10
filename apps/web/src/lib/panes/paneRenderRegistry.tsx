"use client";

import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";

type Module = { default: ComponentType };

// Pane bodies are lazy chunks; the server and the always-loaded shell never
// import them. Two bodies serve two routes each: chats, and pages/daily pages.
const LOADERS: Record<PaneRouteId, () => Promise<Module>> = {
  lectern: () => import("@/app/(authenticated)/lectern/LecternPaneBody"),
  libraries: () => import("@/app/(authenticated)/libraries/LibrariesPaneBody"),
  library: () => import("@/app/(authenticated)/libraries/[id]/LibraryPaneBody"),
  browse: () => import("@/app/(authenticated)/browse/BrowsePaneBody"),
  browsePreview: () =>
    import("@/app/(authenticated)/browse/preview/BrowsePreviewPaneBody"),
  media: () => import("@/app/(authenticated)/media/[id]/MediaPaneBody"),
  artifact: () =>
    import("@/app/(authenticated)/artifacts/[artifactRef]/ArtifactPaneBody"),
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

// One import and one lazy body per route, shared by render and preload. A
// failed import forgets both, so "Retry pane" imports again: React.lazy
// caches a rejection forever.
const modules = new Map<PaneRouteId, Promise<Module>>();
const bodies = new Map<PaneRouteId, ComponentType>();

function load(id: PaneRouteId): Promise<Module> {
  let loaded = modules.get(id);
  if (!loaded) {
    loaded = LOADERS[id]().catch((error: unknown) => {
      modules.delete(id);
      bodies.delete(id);
      throw error;
    });
    modules.set(id, loaded);
  }
  return loaded;
}

export function preloadPane(id: PaneRouteId): Promise<void> {
  return load(id).then(() => undefined);
}

export function renderPane(id: PaneRouteId): ReactNode {
  let Body = bodies.get(id);
  if (!Body) {
    Body = lazy(() => load(id));
    bodies.set(id, Body);
  }
  return (
    <Suspense
      fallback={<PaneLoadingState label="Loading pane…" announcement="Polite" />}
    >
      <Body />
    </Suspense>
  );
}
