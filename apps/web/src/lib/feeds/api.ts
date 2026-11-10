"use client";

// Shared feed transport. Account-memory command
// owners retain exact request identities, publish acknowledgments and invalidate
// reads after uncertainty. Explicit source resolution and refresh publish at admission.

import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { stampedRead, type StampedRead } from "@/lib/consumption/listening";

export type FeedDetail = Schema<"FeedDetailOut">;
export type FeedRow = Schema<"FeedIndexItemOut">;
export type LibraryFeedIndex = Schema<"LibraryFeedIndexOut">;
export type FeedEntryRow = Schema<"FeedEntryListItemOut">;
export type FeedImport = Schema<"FeedImportOut">;
export type FeedSection = Schema<"LibraryFeedsOut">;
export type LibraryFeed = Schema<"LibraryFeedOut">;
export type FeedTarget = Schema<"FeedImportCreateRequest">["target"];
export type FeedActionResult = Schema<"FeedActionResultOut">;
export type FeedActionResolution = FeedActionResult["resolution"];
export type FeedAdmission = Schema<"FeedAdmissionOut">;
export type FeedRemovalPreview = Schema<"FeedRemovalPreviewOut">;
export type FeedKind = Schema<"FeedIndexItemOut">["kind"];
export type EntryState = "all" | "unread" | "in_progress" | "finished";
export type FeedRefreshScope =
  | Schema<"FeedRefreshFeedScope">
  | Schema<"FeedRefreshFeedsScope">
  | Schema<"FeedRefreshLibraryScope">;

export function feedTargetKey(target: FeedTarget): string {
  return JSON.stringify([target.kind, target.kind === "Canonical" ? target.feed_id : target.target]);
}

/** Local identities and aggregate subscription facts; never calls the directory. */
export async function resolveFeedActionFacts(
  targets: readonly FeedTarget[], signal: AbortSignal,
): Promise<FeedActionResult[]> {
  type Body = ApiJson<"/feeds/action-facts/resolve", "post">;
  return (await apiFetch<Body>("/api/feeds/action-facts/resolve", {
    method: "POST", body: JSON.stringify({ targets }), signal,
  })).data.items;
}

/** One complete stamped index observation. */
export async function listFeeds(query: URLSearchParams, signal: AbortSignal) {
  type Body = ApiJson<"/feeds", "get">;
  return stampedRead(await apiFetch<Body>(`/api/feeds?${query}`, { signal }));
}

/** Stamped with its read snapshot's consumption revision; observations reach native. */
export async function getFeedDetail(feedId: string, signal: AbortSignal): Promise<StampedRead<FeedDetail>> {
  type Body = ApiJson<"/feeds/{feed_id}", "get">;
  return stampedRead(await apiFetch<Body>(`/api/feeds/${feedId}`, { signal }));
}

/** One complete stamped index observation. */
export async function listFeedEntries(feedId: string, query: URLSearchParams, signal: AbortSignal) {
  type Body = ApiJson<"/feeds/{feed_id}/entries", "get">;
  return stampedRead(await apiFetch<Body>(`/api/feeds/${feedId}/entries?${query}`, { signal }));
}

/** Contextless admission reads the default destination's actual revision. */
export async function getDefaultFeedLibrary(signal: AbortSignal): Promise<string> {
  return (await apiFetch<ApiJson<"/me", "get">>("/api/me", { signal })).data.default_library_id;
}

/** Stamped with its read snapshot's consumption revision (a title-only header: no rows). */
export async function getLibraryFeeds(libraryId: string, signal: AbortSignal): Promise<StampedRead<FeedSection>> {
  return stampedRead(await apiFetch<ApiJson<"/libraries/{library_id}/feeds", "get">>(`/api/libraries/${libraryId}/feeds`, { signal }));
}

/** Exact selected relationship; the default section is an aggregate, not membership. */
export async function getLibraryFeed(libraryId: string, feedId: string, signal: AbortSignal): Promise<LibraryFeed> {
  return (await apiFetch<ApiJson<"/libraries/{library_id}/feeds/{feed_id}", "get">>(`/api/libraries/${libraryId}/feeds/${feedId}`, { signal })).data;
}

export async function getFeedImport(libraryId: string, importId: string, signal: AbortSignal): Promise<FeedImport> {
  return (await apiFetch<ApiJson<"/libraries/{library_id}/feed-imports/{import_id}", "get">>(`/api/libraries/${libraryId}/feed-imports/${importId}`, { signal })).data;
}

/** Transport only. Account commands retain client ids and frozen guards. */
export async function admitFeed(libraryId: string, mode: "follow" | "current_items", body: string, signal: AbortSignal): Promise<FeedAdmission> {
  const path = mode === "follow" ? `/api/libraries/${libraryId}/feed-subscriptions` as const : `/api/libraries/${libraryId}/feed-imports` as const;
  return (await apiFetch<{ data: FeedAdmission }>(path, { method: "POST", body, signal })).data;
}

export async function changeFeedImport(libraryId: string, importId: string, action: "cancel" | "retry", body: string, signal: AbortSignal): Promise<FeedImport> {
  return (await apiFetch<{ data: FeedImport }>(`/api/libraries/${libraryId}/feed-imports/${importId}/${action}`, { method: "POST", body, signal })).data;
}

export async function getFeedRemovalPreview(feedId: string, scope: "all" | "library", items: "keep" | "remove", libraryId: string | null, signal: AbortSignal): Promise<FeedRemovalPreview> {
  const query = new URLSearchParams({ scope, items });
  if (libraryId !== null) query.set("library_id", libraryId);
  return (await apiFetch<ApiJson<"/feeds/{feed_id}/removal-preview", "get">>(`/api/feeds/${feedId}/removal-preview?${query}`, { signal })).data;
}

export async function stopFeed(feedId: string, body: string, signal: AbortSignal): Promise<Schema<"FeedStopOut">> {
  return (await apiFetch<ApiJson<"/feeds/{feed_id}/stop", "post">>(`/api/feeds/${feedId}/stop`, { method: "POST", body, signal })).data;
}


export async function resolveFeed(body: Schema<"FeedUrlResolveRequest"> | Schema<"FeedDiscoveryResolveRequest">, signal?: AbortSignal) {
  const { data } = await apiFetch<ApiJson<"/feeds/resolve", "post">>("/api/feeds/resolve", { method: "POST", body: JSON.stringify(body), signal });
  publishChange("Feeds");
  return data;
}
export async function requestFeedRefresh(scope: FeedRefreshScope, signal?: AbortSignal): Promise<number> {
  const response = await apiFetch<ApiJson<"/feeds/refresh", "post">>("/api/feeds/refresh", { method: "POST", body: JSON.stringify(scope), signal });
  publishChange("Feeds");
  return response.data.requested_count;
}
export async function previewOpml(xml: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/feeds/opml/preview", "post">>("/api/feeds/opml/preview", { method: "POST", body: JSON.stringify({ xml }), signal })).data;
}
export async function createOpmlImport(body: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/feed-opml-imports", "post">>("/api/feed-opml-imports", { method: "POST", body, signal })).data;
}
export async function getOpmlImport(id: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/feed-opml-imports/{import_id}", "get">>(`/api/feed-opml-imports/${id}`, { signal })).data;
}
export async function changeOpmlImport(id: string, action: "cancel" | "retry", body: string, signal: AbortSignal) {
  return (await apiFetch<{ data: Schema<"OpmlImportOut"> }>(`/api/feed-opml-imports/${id}/${action}`, { method: "POST", body, signal })).data;
}

export async function getFeedEntryRemovalPreview(mediaId: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/feed-entries/{media_id}/removal-preview", "get">>(`/api/feed-entries/${mediaId}/removal-preview`, { signal })).data;
}
export async function removeFeedEntry(mediaId: string, body: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/feed-entries/{media_id}/remove", "post">>(`/api/feed-entries/${mediaId}/remove`, { method: "POST", body, signal })).data;
}
export async function listOpmlImports(signal: AbortSignal) {
  return (await apiFetch<{ data: { items: Schema<"OpmlImportSummaryOut">[] } }>("/api/feed-opml-imports", { signal })).data.items;
}
