/** Published suggestions and direct quick reads share only their item presentation. */

import { absent, present } from "@/lib/api/presence";
import { apiFetch, requestWithDeadline, type ApiPath } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { SUGGESTIONS_REQUEST_TIMEOUT_MS } from "@/lib/api/suggestionPolicy";
import type { paths } from "@/lib/api/wire.gen";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

export type SuggestionItem = Schema<"SuggestionItemOut">;
export type SuggestionTarget = SuggestionItem["target"];
export type Suggestions = Schema<"SuggestionsOut">;
export type SuggestionPublication = Schema<"SuggestionPublicationOut">;
export type SuggestionState = Schema<"SuggestionStateOut">;
export type SuggestionRefresh = paths["/lectern/suggestions/refresh"]["post"]["requestBody"]["content"]["application/json"];
export type SuggestionObservation = Schema<"SuggestionObservationOut">;
export type QuickReads = Schema<"QuickReadsOut">;
export type SuggestionsDestination =
  | { kind: "Lectern" }
  | { kind: "Library"; id: string; name: string };

export async function getSuggestions(path: ApiPath, signal: AbortSignal): Promise<Suggestions> {
  return requestWithRetry(async (attemptSignal) =>
    (await apiFetch<ApiJson<"/lectern/suggestions", "get">>(path, { signal: attemptSignal })).data,
  signal, { timeoutMs: SUGGESTIONS_REQUEST_TIMEOUT_MS });
}

export async function viewSuggestions(path: ApiPath, refs: string[], signal: AbortSignal) {
  return requestWithRetry(async (attemptSignal) =>
    (await apiFetch<ApiJson<"/lectern/suggestions/view", "post">>(`${path}/view`, {
      method: "POST", body: JSON.stringify({ refs }), signal: attemptSignal,
    })).data,
  signal, { timeoutMs: SUGGESTIONS_REQUEST_TIMEOUT_MS });
}

export async function refreshSuggestions(path: ApiPath, input: SuggestionRefresh, signal: AbortSignal) {
  return requestWithDeadline({ request: async (attemptSignal) =>
    (await apiFetch<ApiJson<"/lectern/suggestions/refresh", "post">>(`${path}/refresh`, {
      method: "POST", body: JSON.stringify(input), signal: attemptSignal,
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

export function presentSuggestionItem({ target }: SuggestionItem): CollectionRowView {
  const actionSubject = { ref: assumeCanonicalResourceRef(target.ref) };
  if (target.kind === "Media") {
    return presentMedia(target.mediaSummary, {
      id: target.ref,
      primary: {
        kind: "link",
        href: target.href,
      },
      actionSubject,
      selected: false,
    });
  }
  return {
    id: target.ref,
    kind: "podcast",
    primary: { kind: "link", href: target.href, paneLabelHint: target.title },
    title: { text: target.title },
    contributors: [],
    publicationDate: absent(),
    context:
      target.subtitle.kind === "Present"
        ? present({ kind: "Text", text: target.subtitle.value })
        : absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    actionSubject,
    selected: false,
  };
}
