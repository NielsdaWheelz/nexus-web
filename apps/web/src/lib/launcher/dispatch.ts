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
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import { createNotePage, quickCaptureDailyNote } from "@/lib/notes/api";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import { activateResource } from "@/lib/resources/activation";
import { copyText } from "@/lib/ui/copyText";
import { subscribeToPodcast } from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import type { LauncherActionTarget } from "./model";

// True when `href` resolves to an in-app route the Android shell can't open (Local
// Vault). Shared by dispatch (block + toast) and the controller (skip logging a
// target the viewer can't actually open). External/unknown routes → false.
export function isAndroidShellRestrictedHref(href: string, androidShell: boolean): boolean {
  return androidShell && isAndroidShellRestrictedRouteId(resolvePaneRoute(href).id);
}

export interface LauncherDispatchCtx {
  androidShell: boolean;
  feedback: ReturnType<typeof useFeedback>;
  defaultLibraryIds: string[];
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
    case "add-url": {
      const res = await addMediaFromUrl({ url: target.url, libraryIds: ctx.defaultLibraryIds });
      requestOpenInAppPane(
        res.duplicate ? `/media/${res.mediaId}?duplicate=true` : `/media/${res.mediaId}`,
      );
      return;
    }
    case "create-note":
      await quickCaptureDailyNote({
        blockId: createRandomId(),
        clientMutationId: createRandomId("quick-note"),
        bodyPmJson: paragraphFromText(target.text).toJSON() as Record<string, unknown>,
      });
      requestOpenInAppPane("/daily", { titleHint: "Today" });
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
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
