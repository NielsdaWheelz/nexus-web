"use client";

import { useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { usePaneReturnReady, type PaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";

type Profile = ApiJson<"/me", "get">["data"];

/** A save's answer stands until a later /me read accepts a new generation. */
export function useProfile(visit: PaneVisitDataKey<Visit<Profile>>): {
  profile: Profile | null;
  failure: { error: unknown; retry(): void; retrying: boolean } | null;
  accept(profile: Profile): void;
  reload(): void;
} {
  const stamp = useChangeStamp("Chats");
  const account = useServerValue({
    key: "/me", stale: stamp, visit,
    load: async signal => (await apiFetch<ApiJson<"/me", "get">>("/api/me", { signal })).data,
  });
  const [saved, setSaved] = useState<{ profile: Profile; over: number } | null>(null);
  const generation = useRef<number | null>(null);
  generation.current = account.status === "ready" ? account.generation : null;
  usePaneReturnReady(account.status !== "loading");
  const reload = () => { void account.refetch(); };
  return {
    profile: account.status !== "ready" ? null : saved?.over === account.generation ? saved.profile : account.data,
    failure: account.status === "failed" ? { error: account.error, retry: reload, retrying: account.retrying } : null,
    accept: profile => {
      // Callers mount field owners only after the profile is ready.
      if (generation.current === null) throw new Error("cannot accept a profile before its read is ready");
      setSaved({ profile, over: generation.current });
      reload();
    },
    reload,
  };
}
