"use client";

import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";

type PaneLoader = () => Promise<{ default: ComponentType }>;

// The ONLY module that imports pane bodies. Each is a lazy entrypoint, so a
// pane's code (markdown, ProseMirror, the reader stack, …) ships in its own
// chunk and loads only when that pane opens — keeping the always-loaded shell
// free of pane code (R4/R6). Imported solely by WorkspaceHost (render) and
// AuthenticatedShell (preload).
const PANE_LOADERS: Record<PaneRouteId, PaneLoader> = {
  lectern: () => import("@/app/(authenticated)/lectern/LecternPaneBody"),
  libraries: () => import("@/app/(authenticated)/libraries/LibrariesPaneBody"),
  library: () => import("@/app/(authenticated)/libraries/[id]/LibraryPaneBody"),
  media: () => import("@/app/(authenticated)/media/[id]/MediaPaneBody"),
  conversations: () => import("@/app/(authenticated)/conversations/ConversationsPaneBody"),
  conversationNew: () => import("@/components/chat/Conversation"),
  conversation: () => import("@/components/chat/Conversation"),
  podcasts: () => import("@/app/(authenticated)/podcasts/PodcastsPaneBody"),
  podcastDetail: () => import("@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody"),
  search: () => import("@/app/(authenticated)/search/SearchPaneBody"),
  author: () => import("@/app/(authenticated)/authors/[handle]/AuthorPaneBody"),
  notes: () => import("@/app/(authenticated)/notes/NotesPaneBody"),
  page: () => import("@/app/(authenticated)/pages/[pageId]/PagePaneBody"),
  note: () => import("@/app/(authenticated)/notes/[blockId]/NotePaneBody"),
  settings: () => import("@/app/(authenticated)/settings/SettingsPaneBody"),
  settingsAccount: () => import("@/app/(authenticated)/settings/account/SettingsAccountPaneBody"),
  settingsBilling: () => import("@/app/(authenticated)/settings/billing/SettingsBillingPaneBody"),
  settingsReader: () => import("@/app/(authenticated)/settings/reader/SettingsReaderPaneBody"),
  settingsAppearance: () =>
    import("@/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody"),
  settingsKeys: () => import("@/app/(authenticated)/settings/keys/SettingsKeysPaneBody"),
  settingsLocalVault: () =>
    import("@/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody"),
  settingsIdentities: () =>
    import("@/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody"),
  settingsKeybindings: () =>
    import("@/app/(authenticated)/settings/keybindings/KeybindingsPaneBody"),
  atlas: () => import("@/app/(authenticated)/atlas/GrandAtlasPaneBody"),
  oracle: () => import("@/app/(authenticated)/oracle/OracleLandingPaneBody"),
  oracleReading: () =>
    import("@/app/(authenticated)/oracle/[readingId]/OracleReadingPaneBody"),
};

const PANE_BODIES = (Object.keys(PANE_LOADERS) as PaneRouteId[]).reduce(
  (bodies, id) => {
    bodies[id] = lazy(PANE_LOADERS[id]);
    return bodies;
  },
  {} as Record<PaneRouteId, ComponentType>,
);

export function renderPane(id: PaneRouteId): ReactNode {
  const Body = PANE_BODIES[id];
  return (
    <Suspense fallback={<PaneLoadingState />}>
      <Body />
    </Suspense>
  );
}

// Start fetching the initial pane's chunk at shell mount, via the Next runtime's
// own (CSP-trusted) module loader, so the download overlaps hydration instead of
// waiting for the Suspense boundary to commit (D-7). We deliberately do NOT
// server-emit a <link rel="modulepreload">: under strict-dynamic nonce-CSP that
// preload is script-src-governed and the chunk URL isn't known server-side — the
// same constraint that bans next/dynamic (D-3). lazy() reuses this warmed module.
export function preloadPane(id: PaneRouteId): Promise<void> {
  return PANE_LOADERS[id]().then(() => undefined);
}
