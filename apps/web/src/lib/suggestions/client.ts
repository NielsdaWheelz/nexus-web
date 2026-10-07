import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import {
  projectSuggestions,
  type SuggestionsSnapshot,
} from "@/lib/suggestions/contract";

export async function getQuickReads(signal?: AbortSignal): Promise<SuggestionsSnapshot> {
  const response = await apiFetch<ApiJson<"/lectern/quick-reads", "get">>(
    "/api/lectern/quick-reads", { signal },
  );
  return projectSuggestions(response.data);
}

export async function getLecternSuggestions(signal?: AbortSignal): Promise<SuggestionsSnapshot> {
  const response = await apiFetch<ApiJson<"/lectern/suggestions", "get">>(
    "/api/lectern/suggestions", { signal },
  );
  return projectSuggestions(response.data);
}

export async function getLibrarySuggestions(
  libraryId: string,
  signal?: AbortSignal,
): Promise<SuggestionsSnapshot> {
  const response = await apiFetch<ApiJson<"/libraries/{library_id}/suggestions", "get">>(
    `/api/libraries/${encodeURIComponent(libraryId)}/suggestions`, { signal },
  );
  return projectSuggestions(response.data);
}
