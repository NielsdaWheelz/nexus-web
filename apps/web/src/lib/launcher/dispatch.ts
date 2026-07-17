/**
 * The single owner of every Launcher open/side-effect. `dispatchTarget` is one
 * exhaustive switch over `LauncherActionTarget` that merges the command palette's
 * old `navigate` + `runAction` switches and replaces the stringly-typed `actionId`
 * escape hatch. It performs the side effect only — the controller owns Launcher
 * open/close state and selection logging. The Android-restricted-route guard and
 * the copy-link toast are centralized here.
 */

"use client";

import type { useFeedback } from "@/components/feedback/Feedback";
import { isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import { createRandomId } from "@/lib/createRandomId";
import { parseMediaId } from "@/lib/lectern/client";
import type { LecternCapability } from "@/lib/lectern/LecternProvider";
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import { createNotePage, quickCaptureDailyNote } from "@/lib/notes/api";
import { openTodayPage } from "@/lib/notes/openToday";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import { activateResource } from "@/lib/resources/activation";
import { requestSearchInputFocus } from "@/lib/search/pendingSearchFocus";
import { copyText } from "@/lib/ui/copyText";
import { subscribeToPodcast } from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import type { LauncherActionTarget } from "./model";

// True when `href` resolves to an in-app route the Android shell can't open (Local
// Vault). Shared by dispatch (block + toast) and the controller (skip logging a
// target the viewer can't actually open). External/unknown routes → false.
export function isAndroidShellRestrictedHref(href: string, androidShell: boolean): boolean {
  return androidShell && isAndroidShellRestrictedRouteId(resolvePaneRoute(href).id);
}

// True when dispatching `target` moves the workspace to a new/other surface (opens or
// switches a pane, or leaves the app). The controller uses this to drop the Launcher's
// return-focus on a navigating close so it doesn't yank focus back from the destination
// it just navigated to; toast-only targets return false and keep the a11y return-focus.
export function targetNavigates(target: LauncherActionTarget): boolean {
  switch (target.kind) {
    case "href":
    case "resource":
    case "ask":
    case "add-url":
    case "browse-acquire":
    case "new-conversation":
    case "create-page":
    case "open-today":
    case "create-note":
    case "pane-open":
      return true;
    case "queue-add":
    case "copy-link":
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
  panes: {
    id: string;
    href: string;
    visibility: "visible" | "minimized";
    title: string;
  }[];
  activatePane(paneId: string): void;
  restorePane(paneId: string): void;
  closePane(paneId: string): void;
}

export async function dispatchTarget(
  target: LauncherActionTarget,
  ctx: LauncherDispatchCtx,
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
      requestOpenInAppPane(target.href, target.titleHint ? { titleHint: target.titleHint } : undefined);
      return;
    case "resource":
      // activateResource owns the external-redirect path; we only pre-guard in-app routes
      // the Android shell can't open.
      if (
        target.activation.kind === "route" &&
        target.activation.href &&
        blockedByAndroid(target.activation.href)
      ) {
        return;
      }
      activateResource(target.activation, {
        label: target.titleHint,
        navigate: (href) => requestOpenInAppPane(href, { titleHint: target.titleHint }),
        openInNewPane: (href, title) =>
          requestOpenInAppPane(href, { titleHint: title ?? target.titleHint }),
      });
      return;
    case "ask":
      requestOpenInAppPane(`/conversations/new?draft=${encodeURIComponent(target.text)}`, {
        titleHint: "New chat",
      });
      return;
    case "queue-add":
      await ctx.placeItems({ mediaIds: [parseMediaId(target.mediaId)], placement: { kind: "Last" } });
      feedback.show({ severity: "success", title: "Added to Lectern" });
      return;
    case "add-url": {
      const res = await addMediaFromUrl({ url: target.url, libraryIds: ctx.defaultLibraryIds });
      requestOpenInAppPane(
        res.duplicate ? `/media/${res.mediaId}?duplicate=true` : `/media/${res.mediaId}`,
      );
      return;
    }
    case "open-today":
      await openTodayPage();
      return;
    case "create-note":
      await quickCaptureDailyNote({
        blockId: createRandomId(),
        clientMutationId: createRandomId("quick-note"),
        bodyPmJson: paragraphFromText(target.text).toJSON() as Record<string, unknown>,
      });
      await openTodayPage();
      return;
    case "browse-acquire": {
      // Documents/videos become owned media; podcasts/episodes subscribe to a podcast.
      // Exhaustive over BrowseResult["type"] so a new browse kind is a compile error here.
      const result = target.result;
      switch (result.type) {
        case "documents":
        case "videos": {
          if (result.media_id) {
            requestOpenInAppPane(`/media/${result.media_id}`, { titleHint: result.title });
            return;
          }
          const added = await addMediaFromUrl({
            url: result.type === "documents" ? result.url : result.watch_url,
            libraryIds: ctx.defaultLibraryIds,
          });
          requestOpenInAppPane(`/media/${added.mediaId}`, { titleHint: result.title });
          return;
        }
        case "podcasts": {
          if (result.podcast_id) {
            requestOpenInAppPane(`/podcasts/${result.podcast_id}`, { titleHint: result.title });
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
          requestOpenInAppPane(`/podcasts/${subscribed.podcast_id}`, { titleHint: result.title });
          return;
        }
        case "podcast_episodes": {
          if (result.podcast_id) {
            requestOpenInAppPane(`/podcasts/${result.podcast_id}`, { titleHint: result.podcast_title });
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
          requestOpenInAppPane(`/podcasts/${subscribed.podcast_id}`, {
            titleHint: result.podcast_title,
          });
          return;
        }
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    }
    case "new-conversation":
      requestOpenInAppPane("/conversations/new", { titleHint: "New chat" });
      return;
    case "create-page": {
      const created = await createNotePage({ title: "Untitled" });
      setPendingNoteFocus({ pageId: created.id, target: "title" });
      requestOpenInAppPane(`/pages/${created.id}`, { titleHint: created.title });
      return;
    }
    case "copy-link":
      if (typeof window !== "undefined") {
        copyText(new URL(target.href, window.location.origin).toString());
      }
      feedback.show({ severity: "success", title: "Link copied" });
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
