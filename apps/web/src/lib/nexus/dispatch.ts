"use client";

import type { useFeedback } from "@/components/feedback/Feedback";
import { isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import { fetchDailyNotePage } from "@/lib/notes/api";
import { todayLocalDate } from "@/lib/localDate";
import { parseMediaId } from "@/lib/lectern/contract";
import type { LecternCapability } from "@/lib/lectern/LecternProvider";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import {
  executeResourceChat,
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import { requestSearchInputFocus } from "@/lib/search/pendingSearchFocus";
import type {
  ShareOpenOptions,
  ShareTarget,
} from "@/lib/sharing/types";
import { copyText } from "@/lib/ui/copyText";
import type {
  WorkspaceTarget,
  WorkspaceTargetActivationRequest,
  WorkspaceTargetActivationResult,
} from "@/lib/workspace/targetActivation";
import type { NexusTarget, NexusTargetActivation } from "./model";

export function isAndroidShellRestrictedHref(
  href: string,
  androidShell: boolean,
): boolean {
  return (
    androidShell &&
    isAndroidShellRestrictedRouteId(resolvePaneRoute(href).id)
  );
}

export const PROGRAMMATIC_NEXUS_TARGET_ACTIVATION: NexusTargetActivation = {
  disposition: { kind: "Follow" },
  modality: "Programmatic",
};

export const PROGRAMMATIC_ADOPT_NEXUS_TARGET_ACTIVATION: NexusTargetActivation =
  {
    disposition: { kind: "Adopt" },
    modality: "Programmatic",
  };

export const KEYBOARD_NEXUS_TARGET_ACTIVATION: NexusTargetActivation = {
  disposition: { kind: "Follow" },
  modality: "Keyboard",
};

export type NexusDispatchOutcome =
  | { kind: "Stayed" }
  | { kind: "NavigationAccepted" }
  | {
      kind: "NavigationRejected";
      reason: "PaneLimitReached";
      target: WorkspaceTarget;
    }
  | {
      kind: "WorkflowRequested";
      target: Extract<
        NexusTarget,
        {
          kind:
            | "OpenAdd"
            | "OpenTodayCapture"
            | "CreatePage"
            | "CreateLibrary"
            | "PodcastDiscovery"
            | "OpenWebSearch";
        }
      >;
      activation: NexusTargetActivation;
    };

export interface NexusPaneTarget {
  readonly id: string;
  readonly href: string;
  readonly visibility: "visible" | "minimized";
  readonly label: string;
}

export interface NexusDispatchCtx {
  readonly androidShell: boolean;
  readonly feedback: ReturnType<typeof useFeedback>;
  readonly activePaneId: string;
  activateWorkspaceTarget(
    request: WorkspaceTargetActivationRequest,
  ): WorkspaceTargetActivationResult;
  readonly placeItems: LecternCapability["placeItems"];
  readonly panes: readonly NexusPaneTarget[];
  activatePane(paneId: string): void;
  restorePane(paneId: string): void;
  closePane(paneId: string): void;
  openShare(target: ShareTarget, options: ShareOpenOptions): void;
  shareOptions(): ShareOpenOptions;
}

function activationOutcome(
  target: WorkspaceTarget,
  result: WorkspaceTargetActivationResult,
): NexusDispatchOutcome {
  return result.kind === "Rejected"
    ? {
        kind: "NavigationRejected",
        reason: result.reason,
        target,
      }
    : { kind: "NavigationAccepted" };
}

function activateTarget(
  target: WorkspaceTarget,
  context: NexusDispatchCtx,
  activation: NexusTargetActivation,
): NexusDispatchOutcome {
  return activationOutcome(
    target,
    context.activateWorkspaceTarget({
      originPaneId: context.activePaneId,
      target,
      disposition: activation.disposition,
      modality: activation.modality,
    }),
  );
}

export function nexusTargetNavigates(target: NexusTarget): boolean {
  switch (target.kind) {
    case "InternalHref":
    case "ResourceOpen":
    case "ResourceShare":
    case "ResourceChat":
    case "Ask":
    case "NewConversation":
    case "Share":
    case "PaneOpen":
    case "OpenToday":
      return true;
    case "QueueAdd":
    case "CopyExternalLink":
    case "PaneClose":
    case "OpenAdd":
    case "OpenTodayCapture":
    case "CreatePage":
    case "CreateLibrary":
    case "PodcastDiscovery":
    case "OpenWebSearch":
      return false;
  }
}

export async function dispatchNexusTarget(
  target: NexusTarget,
  context: NexusDispatchCtx,
  activation: NexusTargetActivation,
): Promise<NexusDispatchOutcome> {
  const blockedByAndroid = (href: string): boolean => {
    if (!isAndroidShellRestrictedHref(href, context.androidShell)) {
      return false;
    }
    context.feedback.show({
      severity: "warning",
      title: "Local Vault is not available in the Android app.",
    });
    return true;
  };

  switch (target.kind) {
    case "InternalHref":
      if (blockedByAndroid(target.href)) return { kind: "Stayed" };
      if (resolvePaneRoute(target.href).id === "search") {
        requestSearchInputFocus();
      }
      return activateTarget(
        { href: target.href, labelHint: target.labelHint },
        context,
        activation,
      );
    case "ResourceOpen": {
      if (
        target.subject.activation.kind === "route" &&
        target.subject.activation.href !== null &&
        blockedByAndroid(target.subject.activation.href)
      ) {
        return { kind: "Stayed" };
      }
      let outcome: NexusDispatchOutcome = { kind: "Stayed" };
      executeResourceOpen({
        target: target.subject,
        resourceNavigation: {
          labelHint: target.labelHint,
          disposition: activation.disposition,
          activateTarget: ({ target: workspaceTarget, disposition }) => {
            outcome = activationOutcome(
              workspaceTarget,
              context.activateWorkspaceTarget({
                originPaneId: context.activePaneId,
                target: workspaceTarget,
                disposition,
                modality: activation.modality,
              }),
            );
          },
        },
      });
      return target.subject.activation.kind === "external"
        ? { kind: "NavigationAccepted" }
        : outcome;
    }
    case "ResourceShare":
      executeResourceShare({
        subject: target.subject,
        openShare: context.openShare,
        options: context.shareOptions(),
      });
      return { kind: "NavigationAccepted" };
    case "ResourceChat": {
      let outcome: NexusDispatchOutcome = { kind: "Stayed" };
      await executeResourceChat({
        ref: target.ref,
        openConversation: (conversationId) => {
          const workspaceTarget = {
            href: `/conversations/${conversationId}`,
            labelHint: "Chat",
          };
          outcome = activationOutcome(
            workspaceTarget,
            context.activateWorkspaceTarget({
              originPaneId: context.activePaneId,
              target: workspaceTarget,
              disposition: activation.disposition,
              modality: activation.modality,
            }),
          );
        },
      });
      return outcome;
    }
    case "Ask":
      return activateTarget(
        {
          href: `/conversations/new?draft=${encodeURIComponent(target.text)}`,
          labelHint: "New chat",
        },
        context,
        activation,
      );
    case "QueueAdd":
      await context.placeItems({
        mediaIds: [parseMediaId(target.mediaId)],
        placement: { kind: "Last" },
      });
      context.feedback.show({
        severity: "success",
        title: "Added to Lectern",
      });
      return { kind: "Stayed" };
    case "NewConversation":
      return activateTarget(
        {
          href: target.initialDraft
            ? `/conversations/new?draft=${encodeURIComponent(target.initialDraft)}`
            : "/conversations/new",
          labelHint: "New chat",
        },
        context,
        activation,
      );
    case "Share":
      context.openShare(target.target, context.shareOptions());
      return { kind: "NavigationAccepted" };
    case "CopyExternalLink":
      await copyText(target.href);
      context.feedback.show({
        severity: "success",
        title: "External link copied",
      });
      return { kind: "Stayed" };
    case "PaneOpen": {
      const pane = context.panes.find((candidate) => candidate.id === target.paneId);
      if (!pane) return { kind: "Stayed" };
      if (blockedByAndroid(pane.href)) return { kind: "Stayed" };
      if (activation.disposition.kind === "Fork") {
        return activateTarget(
          { href: pane.href, labelHint: pane.label },
          context,
          activation,
        );
      }
      if (pane.visibility === "minimized") context.restorePane(pane.id);
      else context.activatePane(pane.id);
      return { kind: "NavigationAccepted" };
    }
    case "PaneClose":
      context.closePane(target.paneId);
      return { kind: "Stayed" };
    case "OpenToday": {
      const page = await fetchDailyNotePage(todayLocalDate());
      return activateTarget(
        { href: `/pages/${page.id}`, labelHint: page.title },
        context,
        activation,
      );
    }
    case "OpenAdd":
    case "OpenTodayCapture":
    case "CreatePage":
    case "CreateLibrary":
    case "PodcastDiscovery":
    case "OpenWebSearch":
      return { kind: "WorkflowRequested", target, activation };
  }
}
