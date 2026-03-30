"use client";

import { useEffect, useMemo, useRef } from "react";
import PaneRouteRenderer from "@/components/PaneRouteRenderer";
import WorkspaceShell, { type WorkspaceShellPane } from "@/components/workspace/WorkspaceShell";
import {
  MAX_STANDARD_PANE_WIDTH_PX,
  MIN_PANE_WIDTH_PX,
  type WorkspacePaneStateV3,
} from "@/lib/workspace/schema";
import { resolvePaneDescriptor } from "@/lib/workspace/paneDescriptor";
import { resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import { useWorkspaceStore } from "@/lib/workspace/store";
import styles from "./WorkspaceHost.module.css";

function buildShellPane(input: {
  pane: WorkspacePaneStateV3;
  nowMs: number;
  runtimeTitleByPaneId: ReadonlyMap<string, string>;
  openHintByPaneId: ReadonlyMap<string, { titleHint?: string; resourceRef?: string | null }>;
  resourceTitleByRef: ReadonlyMap<
    string,
    {
      title: string;
      updatedAtMs: number;
      expiresAtMs: number;
    }
  >;
  onNavigatePane: (paneId: string, href: string, options?: { replace?: boolean }) => void;
  onOpenPane: (input: { href: string; openerPaneId?: string | null; activate?: boolean }) => void;
  onPublishPaneTitle: (
    paneId: string,
    title: string | null,
    options?: { resourceRef?: string | null }
  ) => void;
  isActive: boolean;
}): WorkspaceShellPane {
  const route = resolvePaneRoute(input.pane.href);
  const descriptor = resolvePaneDescriptor(input.pane, {
    nowMs: input.nowMs,
    runtimeTitleByPaneId: input.runtimeTitleByPaneId,
    openHintByPaneId: input.openHintByPaneId,
    resourceTitleByRef: input.resourceTitleByRef,
  });
  const chrome = route.definition?.getChrome({
    href: input.pane.href,
    params: route.params,
  });
  const title = input.pane.companionOfPaneId
    ? chrome?.title || descriptor.resolvedTitle || "Pane"
    : descriptor.resolvedTitle || chrome?.title || "Pane";

  return {
    paneId: input.pane.id,
    title,
    subtitle: chrome?.subtitle,
    toolbar: chrome?.toolbar,
    actions: chrome?.actions,
    bodyMode: route.definition?.bodyMode ?? "standard",
    widthPx: input.pane.widthPx,
    minWidthPx: route.definition?.minWidthPx ?? MIN_PANE_WIDTH_PX,
    maxWidthPx: route.definition?.maxWidthPx ?? MAX_STANDARD_PANE_WIDTH_PX,
    isActive: input.isActive,
    content: (
      <div className={styles.routeShell}>
        <PaneRouteRenderer
          paneId={input.pane.id}
          href={input.pane.href}
          onNavigatePane={(paneId, href) => input.onNavigatePane(paneId, href)}
          onReplacePane={(paneId, href) => input.onNavigatePane(paneId, href, { replace: true })}
          onOpenInNewPane={(href) =>
            input.onOpenPane({
              href,
              openerPaneId: input.pane.id,
              activate: true,
            })
          }
          onSetPaneTitle={(paneId, paneTitle, metadata) => {
            input.onPublishPaneTitle(paneId, paneTitle, {
              resourceRef: metadata.resourceRef,
            });
          }}
        />
      </div>
    ),
  };
}

export default function WorkspaceHost() {
  const {
    state,
    runtimeTitleByPaneId,
    openHintByPaneId,
    resourceTitleByRef,
    activatePane,
    openPane,
    navigatePane,
    closePane,
    closePaneFamily,
    resizePane,
    publishPaneTitle,
  } = useWorkspaceStore();
  const titleTelemetryByPaneIdRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const nowMs = Date.now();
    const nextTelemetryByPaneId = new Map<string, string>();

    for (const pane of state.panes) {
      const descriptor = resolvePaneDescriptor(pane, {
        nowMs,
        runtimeTitleByPaneId,
        openHintByPaneId,
        resourceTitleByRef,
      });
      const telemetryKey = [
        descriptor.resolvedTitle,
        descriptor.titleSource,
        descriptor.routeId,
      ].join("|");
      nextTelemetryByPaneId.set(pane.id, telemetryKey);
      if (titleTelemetryByPaneIdRef.current.get(pane.id) === telemetryKey) {
        continue;
      }
      emitWorkspaceTelemetry({
        type: "title",
        status: descriptor.titleSource === "safe_fallback" ? "fallback" : "ok",
        errorCode: descriptor.titleSource === "safe_fallback" ? "safe_fallback_title" : null,
        titleSource: descriptor.titleSource,
        routeId: descriptor.routeId,
      });
    }

    titleTelemetryByPaneIdRef.current = nextTelemetryByPaneId;
  }, [openHintByPaneId, resourceTitleByRef, runtimeTitleByPaneId, state.panes]);

  const panes = useMemo(
    () =>
      state.panes.map((pane) =>
        buildShellPane({
          pane,
          nowMs: Date.now(),
          runtimeTitleByPaneId,
          openHintByPaneId,
          resourceTitleByRef,
          onNavigatePane: navigatePane,
          onOpenPane: openPane,
          onPublishPaneTitle: publishPaneTitle,
          isActive: pane.id === state.activePaneId,
        })
      ),
    [
      state.panes,
      state.activePaneId,
      runtimeTitleByPaneId,
      openHintByPaneId,
      resourceTitleByRef,
      navigatePane,
      openPane,
      publishPaneTitle,
    ]
  );

  return (
    <WorkspaceShell
      panes={panes}
      activePaneId={state.activePaneId}
      onActivatePane={activatePane}
      onClosePane={(paneId) => {
        const pane = state.panes.find((candidate) => candidate.id === paneId);
        if (!pane) {
          return;
        }
        if (!pane.companionOfPaneId) {
          closePaneFamily(paneId);
          return;
        }
        closePane(paneId);
      }}
      onResizePane={resizePane}
    />
  );
}
