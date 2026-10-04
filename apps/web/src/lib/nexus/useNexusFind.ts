"use client";

// Every server read of the Nexus and its one server write. Reads are gated for latency:
// openables first, owned search only once openables settled for the same text, and typed
// history only once the last of those settled.
import { useEffect, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { absent } from "@/lib/api/presence";
import { apiFetch, apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useResource } from "@/lib/api/useResource";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { searchOpenableResources } from "@/lib/resources/openableResources";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import { SEARCH_KINDS } from "@/lib/search/kinds";
import { fetchSearchResultPage } from "@/lib/search/searchApi";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import type { NexusRecent, NexusSource } from "./model";
import type { NexusQuery } from "./query";

type History = ApiJson<"/me/nexus-history", "get">;

const EMPTY_RECENT: readonly NexusRecent[] = [];
const EMPTY_FRECENCY: Readonly<Record<string, number>> = {};
const EMPTY_ITEMS: readonly ResourceItem[] = [];
const EMPTY_SEARCH: readonly SearchResultRowViewModel[] = [];
const HISTORY_FEEDBACK_KEY = "nexus-history-save";
export const TRANSPORT_CODES = ["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"];

export function useNexusFind({ open, query }: { open: boolean; query: NexusQuery }) {
  const { accountId } = useAuthenticatedAccount();
  const feedback = useFeedback();
  const [historyWanted, setHistoryWanted] = useState(false);
  const [revision, setRevision] = useState(0);
  const [openablesRetry, setOpenablesRetry] = useState(0);
  const [ownedRetry, setOwnedRetry] = useState(0);
  const [showBusy, setShowBusy] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    if (open) setHistoryWanted(true);
  }, [open]);

  const text = query.text;
  const base = useResource<History>({
    cacheKey: historyWanted ? `${accountId}:nexus-history:${revision}` : null,
    load: (signal) => apiFetch<History>("/api/me/nexus-history", { signal }),
  });

  const openablesId = open && text ? text : null;
  const openables = useDebouncedFetch(
    openablesId === null ? null : `${openablesId}\0${openablesRetry}`,
    (signal) => searchOpenableResources({ q: text, schemes: absent(), signal }),
    { debounceMs: text.length === 1 ? 0 : 80, identity: openablesId },
  );
  const openablesSettled =
    openablesId !== null && (openables.dataIdentity === openablesId || openables.errorIdentity === openablesId);
  const ownedId = open && text.length >= 2 && openablesSettled ? text : null;
  const owned = useDebouncedFetch(
    ownedId === null ? null : `${ownedId}\0${ownedRetry}`,
    (signal) => {
      const kinds = query.searchQuery.requestedKinds ?? new Set(SEARCH_KINDS);
      return fetchSearchResultPage(
        { ...query.searchQuery, requestedKinds: new Set([...kinds].filter((kind) => kind !== "web")) },
        { limit: 40, cursor: null, signal },
      );
    },
    { debounceMs: 160, identity: ownedId },
  );
  const ownedSettled = ownedId !== null && (owned.dataIdentity === ownedId || owned.errorIdentity === ownedId);
  const typedId = openablesId !== null && (text.length === 1 ? openablesSettled : ownedSettled) ? text : null;
  const typed = useResource<History>({
    cacheKey: typedId === null ? null : `${accountId}:nexus-history:${revision}:${typedId}`,
    load: (signal) => apiFetch<History>(`/api/me/nexus-history?${new URLSearchParams({ query: text })}`, { signal }),
  });

  const openablesError = openables.errorIdentity === openablesId ? openables.error : null;
  const ownedError = owned.errorIdentity === ownedId ? owned.error : null;
  const contractDefect = [openablesError, ownedError].find(
    (error) =>
      error !== null && (!isApiError(error) || isSameSystemApiDefect(error)),
  );
  if (contractDefect) throw contractDefect;
  if (defect) throw defect.error;

  const remoteBusy = openables.loading || owned.loading;
  useEffect(() => {
    if (!remoteBusy) {
      setShowBusy(false);
      return;
    }
    const timer = window.setTimeout(() => setShowBusy(true), 150);
    return () => window.clearTimeout(timer);
  }, [remoteBusy]);

  const failures = new Set<NexusSource>();
  if (openablesError) failures.add("Openables");
  if (ownedError) failures.add("Owned");
  const baseData = base.status === "ready" ? base.data.data : null;
  const typedFrecency = text && typed.status === "ready" ? typed.data.data.frecency_by_href : null;

  /** Record an accepted selection now; a transport failure offers Retry with the same mutation id. */
  const remember = (selection: Omit<Schema<"NexusSelectionRecordRequest">, "client_mutation_id">) => {
    const body = JSON.stringify({ client_mutation_id: crypto.randomUUID(), ...selection });
    const send = () =>
      apiFetch<ApiJson<"/me/nexus-selections", "post">>("/api/me/nexus-selections", { method: "POST", keepalive: true, body }).then(
        () => {
          feedback.resolve(HISTORY_FEEDBACK_KEY);
          setRevision((value) => value + 1);
        },
        (error: unknown) => {
          if (handleUnauthenticatedApiError(error)) return;
          const content = isApiError(error) && TRANSPORT_CODES.includes(error.code)
            ? apiTransportFeedback(error, "Nexus history wasn’t saved")
            : null;
          if (content === null) {
            // justify-defect: history admits only auth recovery and declared transport feedback.
            setDefect({ error });
            return;
          }
          feedback.publish({
            kind: "Persistent",
            key: HISTORY_FEEDBACK_KEY,
            announcement: "Polite",
            content,
            actions: [
              {
                label: "Retry",
                onClick: () => {
                  feedback.resolve(HISTORY_FEEDBACK_KEY);
                  void send();
                },
              },
            ],
          });
        },
      );
    void send();
  };

  return {
    recent: baseData?.recent ?? EMPTY_RECENT,
    frecency: typedFrecency ?? baseData?.frecency_by_href ?? EMPTY_FRECENCY,
    openables: (openables.dataIdentity === openablesId ? openables.data?.items : null) ?? EMPTY_ITEMS,
    search: (owned.dataIdentity === ownedId ? owned.data?.rows : null) ?? EMPTY_SEARCH,
    busy: showBusy && remoteBusy,
    pending: remoteBusy,
    failures,
    retry: (source: NexusSource) => (source === "Openables" ? setOpenablesRetry : setOwnedRetry)((value) => value + 1),
    remember,
  };
}
