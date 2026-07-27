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
import { createNotePage, quickCaptureDailyNote } from "@/lib/notes/api";
import { openTodayPage } from "@/lib/notes/openToday";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import { requestWorkspaceTargetActivation } from "@/lib/workspace/workspaceTargetActivationIngress";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
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

function activateLauncherTarget(
  target: { href: string; labelHint?: string },
  activation: LauncherTargetActivation,
): void {
  requestWorkspaceTargetActivation({
    target,
    disposition: activation.disposition,
    modality: activation.modality,
  });
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
    case "create-page":
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
): Promise<void> {
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
        return;
      }
      if (blockedByAndroid(target.href)) return;
      // Navigating to the search surface (Go to Authors / Search) declares intent to
      // type: ask that pane to focus its box on arrival. SearchPaneBody enforces the
      // blank-query gate, so a search href carrying a query never grabs focus.
      if (resolvePaneRoute(target.href).id === "search") requestSearchInputFocus();
      activateLauncherTarget(
        { href: target.href, labelHint: target.labelHint },
        activation,
      );
      return;
    case "ResourceOpen":
      // The shared executor owns route/external activation; Launcher only
      // supplies its workspace navigation boundary and Android preflight.
      if (
        target.subject.activation.kind === "route" &&
        target.subject.activation.href &&
        blockedByAndroid(target.subject.activation.href)
      ) {
        return;
      }
      executeResourceOpen({
        target: target.subject,
        resourceNavigation: {
          labelHint: target.labelHint,
          activateTarget: ({ target, disposition }) => {
            requestWorkspaceTargetActivation({
              target,
              disposition,
              modality: activation.modality,
            });
          },
          disposition: activation.disposition,
        },
      });
      return;
    case "ResourceShare":
      executeResourceShare({
        subject: target.subject,
        openShare: ctx.openShare,
        options: ctx.shareOptions(),
      });
      return;
    case "ResourceChat": {
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
          requestWorkspaceTargetActivation({
            target: { href: `/conversations/${conversationId}`, labelHint: "Chat" },
            disposition,
            modality: activation.modality,
          });
        },
      });
      return;
    }
    case "Ask":
      activateLauncherTarget({
        href: `/conversations/new?draft=${encodeURIComponent(target.text)}`,
        labelHint: "New chat",
      }, activation);
      return;
    case "queue-add":
      await ctx.placeItems({ mediaIds: [parseMediaId(target.mediaId)], placement: { kind: "Last" } });
      feedback.show({ severity: "success", title: "Added to Lectern" });
      return;
    case "add-url": {
      const res = await addMediaFromUrl({ url: target.url, libraryIds: ctx.defaultLibraryIds });
      activateLauncherTarget({
        href: res.duplicate ? `/media/${res.mediaId}?duplicate=true` : `/media/${res.mediaId}`,
      }, activation);
      return;
    }
    case "open-today":
      await openTodayPage(activation);
      return;
    case "create-note":
      await quickCaptureDailyNote({
        blockId: createRandomId(),
        clientMutationId: createRandomId("quick-note"),
        bodyPmJson: paragraphFromText(target.text).toJSON() as Record<string, unknown>,
      });
      await openTodayPage(activation);
      return;
    case "browse-acquire": {
      // Documents/videos become owned media; podcasts/episodes subscribe to a podcast.
      // Exhaustive over BrowseResult["type"] so a new browse kind is a compile error here.
      const result = target.result;
      switch (result.type) {
        case "documents":
        case "videos": {
          if (result.media_id) {
            activateLauncherTarget({ href: `/media/${result.media_id}`, labelHint: result.title }, activation);
            return;
          }
          const added = await addMediaFromUrl({
            url: result.type === "documents" ? result.url : result.watch_url,
            libraryIds: ctx.defaultLibraryIds,
          });
          activateLauncherTarget({ href: `/media/${added.mediaId}`, labelHint: result.title }, activation);
          return;
        }
        case "podcasts": {
          if (result.podcast_id) {
            activateLauncherTarget({ href: `/podcasts/${result.podcast_id}`, labelHint: result.title }, activation);
            return;
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
          activateLauncherTarget({ href: `/podcasts/${subscribed.podcast_id}`, labelHint: result.title }, activation);
          return;
        }
        case "podcast_episodes": {
          if (result.podcast_id) {
            activateLauncherTarget({ href: `/podcasts/${result.podcast_id}`, labelHint: result.podcast_title }, activation);
            return;
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
          activateLauncherTarget({ href: `/podcasts/${subscribed.podcast_id}`, labelHint: result.podcast_title }, activation);
          return;
        }
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    }
    case "new-conversation":
      activateLauncherTarget({ href: "/conversations/new", labelHint: "New chat" }, activation);
      return;
    case "create-page": {
      const created = await createNotePage({ title: "Untitled" });
      setPendingNoteFocus({ pageId: created.id, target: "title" });
      activateLauncherTarget({ href: `/pages/${created.id}`, labelHint: created.title }, activation);
      return;
    }
    case "share":
      ctx.openShare(target.target, ctx.shareOptions());
      return;
    case "copy-external-link":
      if (typeof window !== "undefined") {
        await copyText(target.href);
      }
      feedback.show({ severity: "success", title: "External link copied" });
      return;
    case "pane-open": {
      const pane = ctx.panes.find((entry) => entry.id === target.paneId);
      if (pane && blockedByAndroid(pane.href)) return;
      if (pane?.visibility === "minimized") ctx.restorePane(target.paneId);
      else ctx.activatePane(target.paneId);
      return;
    }
    case "pane-close":
      ctx.closePane(target.paneId);
      return;
    case "set-lane":
      // The controller intercepts set-lane before dispatch is called; this case
      // exists only for TypeScript exhaustiveness.
      return;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
