"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import AppNav from "@/components/appnav/AppNav";
import Nexus from "@/components/nexus/Nexus";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import type { AuthenticatedAccount } from "@/lib/account/contract";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import {
  ResourceCacheProvider,
  type DehydratedResources,
} from "@/lib/api/resourceCache";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import ActivityCaptureLifecycle from "@/lib/consumption/ActivityCaptureLifecycle";
import { readerSurfaceStyle } from "@/lib/documentReader/DocumentReader";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { MediaSummaryProvider } from "@/lib/media/MediaSummaryProvider";
import { MobileChromeProvider } from "@/lib/mobileShell/chrome";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import { connectOffline } from "@/lib/offline/bridge";
import { GlobalPlayerProvider } from "@/lib/player/playerRuntime";
import {
  ReaderProvider,
  useReaderContext,
  type ReaderProfile,
} from "@/lib/reader/ReaderContext";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import type { WorkspaceState } from "@/lib/workspace/model";
import { estimatePrimaryWidthPx } from "@/lib/workspace/paneSizing";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import styles from "./layout.module.css";

export default function AuthenticatedShell(props: {
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  resources: DehydratedResources;
}) {
  return (
    <AuthenticatedAccountProvider account={props.account}>
      <RenderEnvironmentProvider value={props.renderEnvironment}>
        <UnauthenticatedApiBoundary>
          <ActivityCaptureLifecycle />
          <ResourceCacheProvider value={props.resources}>
            <KeybindingsProvider>
              <ReaderProvider initialProfile={props.readerProfile}>
                <Workspace
                  accountId={props.account.accountId}
                  initialState={props.initialState}
                />
              </ReaderProvider>
            </KeybindingsProvider>
          </ResourceCacheProvider>
        </UnauthenticatedApiBoundary>
      </RenderEnvironmentProvider>
    </AuthenticatedAccountProvider>
  );
}

function Workspace(props: { accountId: string; initialState: WorkspaceState }) {
  const { accountId } = props;
  const { profile } = useReaderContext();
  // The reader column is every pane's minimum and default width: the server
  // estimates it from the profile, and this hidden probe measures it.
  const probe = useRef<HTMLDivElement>(null);
  const [columnWidthPx, setColumnWidthPx] = useState(() =>
    estimatePrimaryWidthPx(profile),
  );
  useLayoutEffect(() => {
    const node = probe.current!;
    const measure = () => {
      const width = Math.ceil(node.getBoundingClientRect().width);
      if (width > 0) setColumnWidthPx(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [profile]);
  // Binds Android's offline store to this account.
  useEffect(() => connectOffline(accountId), [accountId]);
  // Harnesses wait for data-hydrated: input before hydration lands on dead markup.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <>
      <div
        ref={probe}
        aria-hidden="true"
        className={styles.columnProbe}
        style={readerSurfaceStyle(profile)}
      />
      <WorkspaceStoreProvider
        initialState={props.initialState}
        columnWidthPx={columnWidthPx}
      >
        <MobileViewportProvider>
          <MobileChromeProvider>
            {/* One Lectern owner wraps the workspace leaves and the player
                runtime. The resource-action runtime reads every provider
                above it; its overlays render inside the player runtime. */}
            <MediaSummaryProvider key={accountId}>
              <LecternProvider>
                <LibraryPlacementControllerProvider>
                  <ShareControllerProvider>
                    <ResourceOverlaysProvider>
                      <GlobalPlayerProvider accountId={accountId}>
                        <ResourceActionRuntimeProvider>
                          <ImportsProvider>
                            <Nexus />
                            <ResourceActionOverlays />
                            <div
                              className={styles.layout}
                              data-hydrated={hydrated || undefined}
                            >
                              <AppNav />
                              <main className={styles.main}>
                                <WorkspaceHost />
                                <GlobalPlayerSurfaces />
                              </main>
                            </div>
                          </ImportsProvider>
                        </ResourceActionRuntimeProvider>
                      </GlobalPlayerProvider>
                    </ResourceOverlaysProvider>
                  </ShareControllerProvider>
                </LibraryPlacementControllerProvider>
              </LecternProvider>
            </MediaSummaryProvider>
          </MobileChromeProvider>
        </MobileViewportProvider>
      </WorkspaceStoreProvider>
    </>
  );
}
