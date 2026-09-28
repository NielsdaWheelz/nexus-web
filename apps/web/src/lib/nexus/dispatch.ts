"use client";

import type { useFeedback } from "@/components/feedback/Feedback";
import { isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import {
  type OpenDailyPageResult,
  type OpenDailyPageTarget,
  resolveDailyLocalDate,
} from "@/lib/notes/openDailyPage";
import { readDailyDraft } from "@/lib/notes/dailyDraftStore";
import { browseHref } from "@/lib/browse/query";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import {
  executeResourceChat,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import { activateResource } from "@/lib/resources/activation";
import type {
  ShareOpenOptions,
  ShareTarget,
} from "@/lib/sharing/types";
import {
  ClipboardWriteUnavailableError,
  copyText,
} from "@/lib/ui/copyText";
import type {
  WorkspaceTarget,
  WorkspaceTargetActivationRequest,
  WorkspaceTargetActivationResult,
} from "@/lib/workspace/targetActivation";
import type {
  MaterializedOpenDailyPageTarget,
  NexusTarget,
  NexusTargetActivation,
  RetainedNexusTarget,
} from "./model";

export type MaterializedNexusTarget =
  | Exclude<NexusTarget, { kind: "OpenDailyPage" }>
  | MaterializedOpenDailyPageTarget;

export function materializeNexusTarget(
  target: NexusTarget,
  context: {
    readonly accountId: string;
    readonly calendarTimeZone: string;
  },
): MaterializedNexusTarget {
  if (target.kind !== "OpenDailyPage") return target;
  const localDate = resolveDailyLocalDate(
    target.date,
    context.calendarTimeZone,
  );
  if (target.entry.kind === "View") {
    return {
      kind: "OpenDailyPage",
      date: { kind: "LocalDate", value: localDate },
      entry: { kind: "View" },
    };
  }
  const draft = readDailyDraft(context.accountId, localDate);
  return {
    kind: "OpenDailyPage",
    date: { kind: "LocalDate", value: localDate },
    entry: {
      kind: "AppendNote",
      initialText: target.entry.initialText,
      noteId: draft?.noteId ?? crypto.randomUUID(),
      clientMutationId: draft?.clientMutationId ?? crypto.randomUUID(),
    },
  };
}

export function isAndroidShellRestrictedHref(
  href: string,
  androidShell: boolean,
): boolean {
  return (
    androidShell &&
    isAndroidShellRestrictedRouteId(resolvePaneRouteModel(href).id)
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

export type NexusDispatchOutcome =
  | { kind: "Stayed" }
  | {
      kind: "OperationBlocked";
      reason: "AndroidRestricted" | "ClipboardUnavailable";
      title: string;
      message?: string;
    }
  | { kind: "NavigationAccepted" }
  | {
      kind: "DailyPageAccepted";
      activationId: string;
      localDate: string;
    }
  | {
      kind: "NavigationRejected";
      reason: "PaneLimitReached";
      target: RetainedNexusTarget;
    }
  | {
      kind: "WorkflowRequested";
      target: Extract<
        NexusTarget,
        {
          kind:
            | "OpenAdd"
            | "CreatePage"
            | "CreateLibrary"
            | "ChooseCreate"
            | "ChooseBrowse"
            | "ManageTabs";
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
  readonly panes: readonly NexusPaneTarget[];
  activatePane(paneId: string): void;
  restorePane(paneId: string): void;
  closePane(paneId: string): void;
  requestPaneSearch(): boolean;
  openShare(target: ShareTarget, options: ShareOpenOptions): void;
  shareOptions(): ShareOpenOptions;
  openDailyPage(
    target: OpenDailyPageTarget,
    activation: NexusTargetActivation,
  ): OpenDailyPageResult;
  resumeCurrentPlayback(): void;
}

function activateTarget(
  target: WorkspaceTarget,
  context: NexusDispatchCtx,
  activation: NexusTargetActivation,
): NexusDispatchOutcome {
  const result = context.activateWorkspaceTarget({
    originPaneId: context.activePaneId,
    target,
    disposition: activation.disposition,
    modality: activation.modality,
  });
  return result.kind === "Rejected"
    ? {
        kind: "NavigationRejected",
        reason: result.reason,
        target: {
          kind: "InternalHref",
          href: target.href,
          labelHint: target.labelHint,
        },
      }
    : { kind: "NavigationAccepted" };
}

export type NexusDispatchResult =
  | NexusDispatchOutcome
  | Promise<NexusDispatchOutcome>;

export function settleNexusDispatch(
  run: () => NexusDispatchResult,
): Promise<NexusDispatchOutcome> {
  try {
    return Promise.resolve(run());
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

export function dispatchNexusTarget(
  target: MaterializedNexusTarget,
  context: NexusDispatchCtx,
  activation: NexusTargetActivation,
): NexusDispatchResult {
  const blockedByAndroid = (href: string): NexusDispatchOutcome | null => {
    if (!isAndroidShellRestrictedHref(href, context.androidShell)) {
      return null;
    }
    return {
      kind: "OperationBlocked",
      reason: "AndroidRestricted",
      title: "Local Vault isn’t available in the Android app",
    };
  };

  switch (target.kind) {
    case "InternalHref": {
      const blocked = blockedByAndroid(target.href);
      if (blocked) return blocked;
      return activateTarget(
        { href: target.href, labelHint: target.labelHint },
        context,
        activation,
      );
    }
    case "ResourceOpen": {
      if (target.activation.kind === "route") {
        const href = target.activation.href;
        const blocked = href === null ? null : blockedByAndroid(href);
        if (blocked) return blocked;
      }
      let outcome: NexusDispatchOutcome = { kind: "Stayed" };
      activateResource(target.activation, {
        labelHint: target.labelHint,
        disposition: activation.disposition,
        activateTarget: ({ target: workspaceTarget, disposition }) => {
          outcome = activateTarget(workspaceTarget, context, {
            disposition,
            modality: activation.modality,
          });
        },
      });
      return target.activation.kind === "external"
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
      return executeResourceChat({
        ref: target.ref,
        openConversation: (conversationId) => {
          outcome = activateTarget(
            { href: `/conversations/${conversationId}`, labelHint: "Chat" },
            context,
            activation,
          );
        },
      }).then(() => outcome);
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
    case "Browse":
      return activateTarget(
        {
          href: browseHref({
            text: target.query,
            kind: target.browseKind,
            source: null,
            sort: "Relevance",
          }),
          labelHint: "Browse",
        },
        context,
        activation,
      );
    case "ResumeCurrentPlayback":
      context.resumeCurrentPlayback();
      return { kind: "Stayed" };
    case "Share":
      context.openShare(target.target, context.shareOptions());
      return { kind: "NavigationAccepted" };
    case "CopyExternalLink":
      return copyText(target.href).then(
        () => {
          context.feedback.publish({
            kind: "Hud",
            content: { tone: "Success", title: "External link copied" },
          });
          return { kind: "Stayed" };
        },
        (error: unknown) => {
          if (!(error instanceof ClipboardWriteUnavailableError)) throw error;
          return {
            kind: "OperationBlocked",
            reason: "ClipboardUnavailable",
            title: "External link wasn’t copied",
            message: "Copy it manually or retry the same link.",
          };
        },
      );
    case "PaneOpen": {
      const pane = context.panes.find((candidate) => candidate.id === target.paneId);
      if (!pane) return { kind: "Stayed" };
      const blocked = blockedByAndroid(pane.href);
      if (blocked) return blocked;
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
    case "PaneSearch":
      return context.requestPaneSearch()
        ? { kind: "NavigationAccepted" }
        : { kind: "Stayed" };
    case "OpenDailyPage": {
      const opened = context.openDailyPage(target, activation);
      if (opened.activation.kind === "Rejected") {
        return {
          kind: "NavigationRejected",
          reason: opened.activation.reason,
          target: {
            ...target,
            date: { kind: "LocalDate", value: opened.localDate },
          },
        };
      }
      return {
        kind: "DailyPageAccepted",
        activationId: opened.activationId,
        localDate: opened.localDate,
      };
    }
    case "OpenAdd":
    case "CreatePage":
    case "CreateLibrary":
    case "ChooseCreate":
    case "ChooseBrowse":
    case "ManageTabs":
      return { kind: "WorkflowRequested", target, activation };
  }
}
