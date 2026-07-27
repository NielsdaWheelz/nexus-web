/**
 * The single owner of every Launcher open/side-effect. `dispatchTarget` is one
 * exhaustive switch over `LauncherActionTarget` that merges the command palette's
 * old `navigate` + `runAction` switches and replaces the stringly-typed `actionId`
 * escape hatch. It performs the side effect only — the controller owns Launcher
 * open/close state and selection logging. The Android-restricted-route guard and
 * clipboard feedback and Share-overlay launch are centralized here.
 */

"use client";

import type { useFeedback } from "@/components/feedback/Feedback";
import { isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import { createRandomId } from "@/lib/createRandomId";
import { parseMediaId } from "@/lib/lectern/contract";
import type { LecternCapability } from "@/lib/lectern/LecternProvider";
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import { fetchDailyNotePage, quickCaptureDailyNote } from "@/lib/notes/api";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import { todayLocalDate } from "@/lib/localDate";
import type {
  WorkspaceTarget,
  WorkspaceTargetActivationRequest,
  WorkspaceTargetActivationResult,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import {
  executeResourceChat,
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import { requestSearchInputFocus } from "@/lib/search/pendingSearchFocus";
import { copyText } from "@/lib/ui/copyText";
import { subscribeToPodcast } from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import type { LauncherActionTarget } from "./model";
import type { LauncherPane } from "./providers";
import type {
  ShareOpenOptions,
  ShareTarget,
} from "@/lib/sharing/types";

// True when `href` resolves to an in-app route the Android shell can't open (Local
// Vault). Shared by dispatch (block + toast) and the controller (skip logging a
// target the viewer can't actually open). External/unknown routes → false.
export function isAndroidShellRestrictedHref(href: string, androidShell: boolean): boolean {
  return androidShell && isAndroidShellRestrictedRouteId(resolvePaneRoute(href).id);
}

export interface LauncherTargetActivation {
  readonly disposition: WorkspaceTargetDisposition;
  readonly modality: PaneNavigationModality;
}

export const PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION: LauncherTargetActivation = {
  disposition: { kind: "Follow" },
  modality: "Programmatic",
};

export const KEYBOARD_LAUNCHER_TARGET_ACTIVATION: LauncherTargetActivation = {
  disposition: { kind: "Follow" },
  modality: "Keyboard",
};

export type DispatchOutcome =
  | { kind: "Stayed" }
  | { kind: "NavigationAccepted" }
  | {
      kind: "NavigationRejected";
      reason: "PaneLimitReached";
      target: WorkspaceTarget;
    };

function activateLauncherTarget(
  target: { href: string; labelHint?: string },
  ctx: LauncherDispatchCtx,
  activation: LauncherTargetActivation,
): DispatchOutcome {
  const result = ctx.activateWorkspaceTarget({
    originPaneId: ctx.activePaneId,
    target,
    disposition: activation.disposition,
    modality: activation.modality,
  });
  return activationOutcome(target, result);
}

function activationOutcome(
  target: WorkspaceTarget,
  result: WorkspaceTargetActivationResult,
): DispatchOutcome {
  return result.kind === "Rejected"
    ? {
        kind: "NavigationRejected",
        reason: result.reason,
        target,
      }
    : { kind: "NavigationAccepted" };
}

// True when dispatching `target` moves the workspace to a new/other surface (opens or
// switches a pane, or leaves the app). The controller uses this to drop the Launcher's
// return-focus on a navigating close so it doesn't yank focus back from the destination
// it just navigated to; toast-only targets return false and keep the a11y return-focus.
export function targetNavigates(target: LauncherActionTarget): boolean {
  switch (target.kind) {
    case "href":
    case "ResourceOpen":
    case "ResourceShare":
    case "ResourceChat":
    case "Ask":
    case "add-url":
    case "browse-acquire":
    case "new-conversation":
    case "open-today":
    case "create-note":
    case "pane-open":
    case "share":
      return true;
    case "queue-add":
    case "copy-external-link":
    case "pane-close":
    case "set-lane":
      return false;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

export interface LauncherDispatchCtx {
  androidShell: boolean;
  feedback: ReturnType<typeof useFeedback>;
  activePaneId: string;
  activateWorkspaceTarget(
    request: WorkspaceTargetActivationRequest,
  ): WorkspaceTargetActivationResult;
  defaultLibraryIds: string[];
  // The one Lectern capability, threaded from the controller (which holds the React
  // context) so this plain-function owner appends media without its own hook access.
  placeItems: LecternCapability["placeItems"];
  panes: LauncherPane[];
  activatePane(paneId: string): void;
  restorePane(paneId: string): void;
  closePane(paneId: string): void;
  openShare(target: ShareTarget, options: ShareOpenOptions): void;
  shareOptions(): ShareOpenOptions;
}

export async function dispatchTarget(
  target: LauncherActionTarget,
  ctx: LauncherDispatchCtx,
  activation: LauncherTargetActivation,
): Promise<DispatchOutcome> {
  const { feedback } = ctx;
  // Centralized Local Vault guard: true (and toasts) when the in-app route is
  // Android-restricted. External-shell hrefs and external resources leave the app
  // and are never route-guarded.
  const blockedByAndroid = (href: string): boolean => {
    if (!isAndroidShellRestrictedHref(href, ctx.androidShell)) {
      return false;
    }
    feedback.show({
      severity: "warning",
      title: "Local Vault is not available in the Android app.",
    });
    return true;
  };

  switch (target.kind) {
    case "href":
      if (target.externalShell) {
        if (typeof window !== "undefined") window.location.assign(target.href);
        return { kind: "NavigationAccepted" };
      }
      if (blockedByAndroid(target.href)) return { kind: "Stayed" };
      // Navigating to the search surface (Go to Authors / Search) declares intent to
      // type: ask that pane to focus its box on arrival. SearchPaneBody enforces the
      // blank-query gate, so a search href carrying a query never grabs focus.
      if (resolvePaneRoute(target.href).id === "search") requestSearchInputFocus();
      return activateLauncherTarget(
        { href: target.href, labelHint: target.labelHint },
        ctx,
        activation,
      );
    case "ResourceOpen":
      // The shared executor owns route/external activation; Launcher only
      // supplies its workspace navigation boundary and Android preflight.
      if (
        target.subject.activation.kind === "route" &&
        target.subject.activation.href &&
        blockedByAndroid(target.subject.activation.href)
      ) {
        return { kind: "Stayed" };
      }
      let resourceOutcome: DispatchOutcome = { kind: "Stayed" };
      executeResourceOpen({
        target: target.subject,
        resourceNavigation: {
          labelHint: target.labelHint,
          activateTarget: ({ target, disposition }) => {
            const result = ctx.activateWorkspaceTarget({
              originPaneId: ctx.activePaneId,
              target: target,
              disposition,
              modality: activation.modality,
            });
            resourceOutcome = activationOutcome(target, result);
          },
          disposition: activation.disposition,
        },
      });
      return target.subject.activation.kind === "external"
        ? { kind: "NavigationAccepted" }
        : resourceOutcome;
    case "ResourceShare":
      executeResourceShare({
        subject: target.subject,
        openShare: ctx.openShare,
        options: ctx.shareOptions(),
      });
      return { kind: "NavigationAccepted" };
    case "ResourceChat": {
      let chatOutcome: DispatchOutcome = { kind: "Stayed" };
      await executeResourceChat({
        ref: target.ref,
        openConversation: (conversationId) => {
          // Resource Chat preserves its source for ordinary selection, but a
          // literal Shift-pointer Fork remains a Fork like every other Launcher
          // target. Keyboard Shift arrives as Follow and therefore stays Adopt.
          const disposition =
            activation.disposition.kind === "Fork"
              ? activation.disposition
              : { kind: "Adopt" as const };
          const workspaceTarget = {
            href: `/conversations/${conversationId}`,
            labelHint: "Chat",
          };
          const result = ctx.activateWorkspaceTarget({
            originPaneId: ctx.activePaneId,
            target: workspaceTarget,
            disposition,
            modality: activation.modality,
          });
          chatOutcome = activationOutcome(workspaceTarget, result);
        },
      });
      return chatOutcome;
    }
    case "Ask":
      return activateLauncherTarget(
        {
          href: `/conversations/new?draft=${encodeURIComponent(target.text)}`,
          labelHint: "New chat",
        },
        ctx,
        activation,
      );
    case "queue-add":
      await ctx.placeItems({ mediaIds: [parseMediaId(target.mediaId)], placement: { kind: "Last" } });
      feedback.show({ severity: "success", title: "Added to Lectern" });
      return { kind: "Stayed" };
    case "add-url": {
      const res = await addMediaFromUrl({ url: target.url, libraryIds: ctx.defaultLibraryIds });
      return activateLauncherTarget(
        {
          href: res.duplicate
            ? `/media/${res.mediaId}?duplicate=true`
            : `/media/${res.mediaId}`,
        },
        ctx,
        activation,
      );
    }
    case "open-today": {
      const page = await fetchDailyNotePage(todayLocalDate());
      return activateLauncherTarget(
        { href: `/pages/${page.id}`, labelHint: page.title },
        ctx,
        activation,
      );
    }
    case "create-note":
      await quickCaptureDailyNote({
        blockId: createRandomId(),
        clientMutationId: createRandomId("quick-note"),
        bodyPmJson: paragraphFromText(target.text).toJSON() as Record<string, unknown>,
      });
      const page = await fetchDailyNotePage(todayLocalDate());
      return activateLauncherTarget(
        { href: `/pages/${page.id}`, labelHint: page.title },
        ctx,
        activation,
      );
    case "browse-acquire": {
      // Documents/videos become owned media; podcasts/episodes subscribe to a podcast.
      // Exhaustive over BrowseResult["type"] so a new browse kind is a compile error here.
      const result = target.result;
      switch (result.type) {
        case "documents":
        case "videos": {
          if (result.media_id) {
            return activateLauncherTarget(
              { href: `/media/${result.media_id}`, labelHint: result.title },
              ctx,
              activation,
            );
          }
          const added = await addMediaFromUrl({
            url: result.type === "documents" ? result.url : result.watch_url,
            libraryIds: ctx.defaultLibraryIds,
          });
          return activateLauncherTarget(
            { href: `/media/${added.mediaId}`, labelHint: result.title },
            ctx,
            activation,
          );
        }
        case "podcasts": {
          if (result.podcast_id) {
            return activateLauncherTarget(
              {
                href: `/podcasts/${result.podcast_id}`,
                labelHint: result.title,
              },
              ctx,
              activation,
            );
          }
          const subscribed = await subscribeToPodcast({
            provider_podcast_id: result.provider_podcast_id,
            title: result.title,
            contributors: result.contributors,
            feed_url: result.feed_url,
            website_url: result.website_url,
            image_url: result.image_url,
            description: result.description,
            library_ids: ctx.defaultLibraryIds,
          });
          return activateLauncherTarget(
            {
              href: `/podcasts/${subscribed.podcast_id}`,
              labelHint: result.title,
            },
            ctx,
            activation,
          );
        }
        case "podcast_episodes": {
          if (result.podcast_id) {
            return activateLauncherTarget(
              {
                href: `/podcasts/${result.podcast_id}`,
                labelHint: result.podcast_title,
              },
              ctx,
              activation,
            );
          }
          const subscribed = await subscribeToPodcast({
            provider_podcast_id: result.provider_podcast_id,
            title: result.podcast_title,
            contributors: result.podcast_contributors,
            feed_url: result.feed_url,
            website_url: result.website_url,
            image_url: result.podcast_image_url,
            description: null,
            library_ids: ctx.defaultLibraryIds,
          });
          return activateLauncherTarget(
            {
              href: `/podcasts/${subscribed.podcast_id}`,
              labelHint: result.podcast_title,
            },
            ctx,
            activation,
          );
        }
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    }
    case "new-conversation":
      return activateLauncherTarget(
        { href: "/conversations/new", labelHint: "New chat" },
        ctx,
        activation,
      );
    case "share":
      ctx.openShare(target.target, ctx.shareOptions());
      return { kind: "NavigationAccepted" };
    case "copy-external-link":
      if (typeof window !== "undefined") {
        await copyText(target.href);
      }
      feedback.show({ severity: "success", title: "External link copied" });
      return { kind: "Stayed" };
    case "pane-open": {
      const pane = ctx.panes.find((entry) => entry.id === target.paneId);
      if (pane && blockedByAndroid(pane.href)) return { kind: "Stayed" };
      if (pane?.visibility === "minimized") ctx.restorePane(target.paneId);
      else ctx.activatePane(target.paneId);
      return pane
        ? { kind: "NavigationAccepted" }
        : { kind: "Stayed" };
    }
    case "pane-close":
      ctx.closePane(target.paneId);
      return { kind: "Stayed" };
    case "set-lane":
      // The controller intercepts set-lane before dispatch is called; this case
      // exists only for TypeScript exhaustiveness.
      return { kind: "Stayed" };
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
