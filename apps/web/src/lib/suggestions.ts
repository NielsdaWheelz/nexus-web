/** Selection modes share publications, item presentation and ordinary actions. */

import { apiFetch, requestWithDeadline, type ApiPath } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retry";
import { SUGGESTIONS_REQUEST_TIMEOUT_MS } from "@/lib/api/suggestionPolicy";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { presentMedia } from "@/lib/collections/presenters/media";
import { presentFeed } from "@/lib/collections/presenters/feed";
import type { CollectionRowView } from "@/lib/collections/types";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

export type SuggestionItem = Schema<"SuggestionItemOut">;
export type SuggestionTarget = SuggestionItem["target"];
export type Suggestions = Schema<"SuggestionsOut">;
export type SuggestionPublication = Schema<"SuggestionPublicationOut">;
export type SuggestionState = Schema<"SuggestionStateOut">;
export type QuickReads = Schema<"QuickReadsOut">;
export type SuggestionsDestination =
  | { kind: "Lectern" }
  | { kind: "Daily" }
  | { kind: "Browse" }
  | { kind: "Library"; id: string; name: string };

export async function getSuggestions(path: ApiPath, signal: AbortSignal): Promise<Suggestions> {
  return (await apiFetch<ApiJson<"/lectern/suggestions", "get">>(path, { signal })).data;
}

export async function viewSuggestions(path: ApiPath, refs: string[], signal: AbortSignal) {
  return requestWithDeadline({
    request: (boundedSignal) => requestWithRetry(async (attemptSignal) =>
      (await apiFetch<ApiJson<"/lectern/suggestions/view", "post">>(`${path}/view`, {
        method: "POST", body: JSON.stringify({ refs }), signal: attemptSignal,
      })).data, boundedSignal),
    signal, timeoutMs: SUGGESTIONS_REQUEST_TIMEOUT_MS,
  });
}

export async function refreshSuggestions(path: ApiPath, signal: AbortSignal) {
  return requestWithDeadline({ request: async (attemptSignal) =>
    (await apiFetch<ApiJson<"/lectern/suggestions/refresh", "post">>(`${path}/refresh`, {
      method: "POST", signal: attemptSignal,
    })).data,
  signal, timeoutMs: SUGGESTIONS_REQUEST_TIMEOUT_MS });
}

export async function getQuickReads(signal: AbortSignal): Promise<QuickReads> {
  return (await apiFetch<ApiJson<"/lectern/quick-reads", "get">>("/api/lectern/quick-reads", { signal })).data;
}

/** The uuid half of a suggestion target's `<scheme>:<uuid>` ref. */
export function suggestionTargetId(target: SuggestionTarget): string {
  return target.ref.slice(target.ref.indexOf(":") + 1);
}

export function presentSuggestionItem({ target, rationale }: SuggestionItem): CollectionRowView {
  const resourceRef = assumeCanonicalResourceRef(target.ref);
  if (target.kind === "Media") {
    const row = presentMedia(target.media_summary, {
      id: target.ref,
      primary: {
        kind: "link",
        href: target.href,
      },
      resourceRef,
      selected: false,
    });
    return { ...row, context: rationale === null ? row.context : { kind: "Text", text: rationale } };
  }
  return {
    ...presentFeed({
      id: target.feed_id,
      kind: target.feed_kind,
      title: target.title,
      subtitle: target.subtitle,
      imageUrl: target.image_url,
      contributors: [],
      recurring: null,
    }),
    context: rationale === null ? null : { kind: "Text", text: rationale },
    id: target.ref,
    primary: { kind: "link", href: target.href, paneLabelHint: target.title },
  };
}
