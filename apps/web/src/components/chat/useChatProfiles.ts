/**
 * useChatProfiles - loads the GET /llm-profiles catalog for the composer.
 *
 * The browser owns NO provider/model/reasoning enum, ordering, default,
 * capability, key, or availability policy (§10) — this hook renders exactly
 * what the endpoint returns; it does not derive a selection or auto-pick
 * logic. That belongs to the composer/ChatProfilePicker consuming this data.
 *
 * The profile list is cached at module scope (`cachedProfiles`/
 * `profilesLoadPromise`) so it survives composer remounts across surfaces —
 * a single `/api/llm-profiles` fetch is shared by every mounted composer,
 * mirroring the useChatModels convention it replaces.
 */

"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { LlmProfile, LlmProfilesOut } from "@/lib/conversations/types";
import { useResource } from "@/lib/api/useResource";

let cachedProfiles: LlmProfilesOut | null = null;
let profilesLoadPromise: Promise<LlmProfilesOut> | null = null;
let profilesCacheEpoch = 0;
const profilesCacheListeners = new Set<() => void>();

export function __resetChatProfilesCacheForTests(): void {
  cachedProfiles = null;
  profilesLoadPromise = null;
  profilesCacheEpoch = 0;
  profilesCacheListeners.clear();
}

export function invalidateChatProfilesCache(): void {
  cachedProfiles = null;
  profilesLoadPromise = null;
  profilesCacheEpoch += 1;
  for (const listener of profilesCacheListeners) {
    listener();
  }
}

function loadChatProfiles(): Promise<LlmProfilesOut> {
  if (cachedProfiles) {
    return Promise.resolve(cachedProfiles);
  }
  if (!profilesLoadPromise) {
    const requestEpoch = profilesCacheEpoch;
    profilesLoadPromise = apiFetch<{ data: LlmProfilesOut }>(
      "/api/llm-profiles",
    )
      .then((response) => {
        if (requestEpoch === profilesCacheEpoch) {
          cachedProfiles = response.data;
        }
        return response.data;
      })
      .catch((error: unknown) => {
        // Drop the rejected promise so the next load retries instead of
        // permanently returning this failure (which would disable SEND for the
        // whole session on one transient blip).
        if (requestEpoch === profilesCacheEpoch) {
          profilesLoadPromise = null;
        }
        throw error;
      });
  }
  return profilesLoadPromise;
}

export interface UseChatProfiles {
  profiles: LlmProfile[];
  defaultProfileId: string | null;
  isLoading: boolean;
  error: Error | null;
}

export function useChatProfiles(): UseChatProfiles {
  const [cacheEpoch, setCacheEpoch] = useState(profilesCacheEpoch);
  const [data, setData] = useState<LlmProfilesOut | null>(
    () => cachedProfiles,
  );

  const profilesResource = useResource<LlmProfilesOut>({
    cacheKey: cachedProfiles ? null : `chat-composer-profiles:${cacheEpoch}`,
    load: () => loadChatProfiles(),
  });

  useEffect(() => {
    const onInvalidated = () => setCacheEpoch(profilesCacheEpoch);
    profilesCacheListeners.add(onInvalidated);
    return () => {
      profilesCacheListeners.delete(onInvalidated);
    };
  }, []);

  useEffect(() => {
    if (profilesResource.status === "ready") {
      setData(profilesResource.data);
      return;
    }
    if (profilesResource.status === "error") {
      console.error("Failed to load LLM profiles:", profilesResource.error);
    }
  }, [profilesResource]);

  return {
    profiles: data?.profiles ?? [],
    defaultProfileId: data?.default_profile_id ?? null,
    isLoading: data === null && profilesResource.status !== "error",
    error: profilesResource.status === "error" ? profilesResource.error : null,
  };
}
