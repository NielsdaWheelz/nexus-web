"use client";

// Every server read of the Nexus and its one server write. Reads are gated for latency:
// openables first, owned search only once openables settled for the same text, and typed
// history only once the last of those settled.
import { useEffect, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, apiTransportFeedback, isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue, useSettled, useThrowLater } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { searchOpenableResources } from "@/lib/resources/items";
import type { ResourceItem } from "@/lib/resources/items";
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
  const [showBusy, setShowBusy] = useState(false);
  const fail = useThrowLater();
  useEffect(() => {
    if (open) setHistoryWanted(true);
  }, [open]);

  const text = query.text;
  const base = usePaneFreeServerValue<History>({
    key: historyWanted ? `${accountId}:nexus-history:${revision}` : null,
    stale: "",
    load: (signal) => apiFetch<History>("/api/me/nexus-history", { signal }),
  });

  // Each search reads once its text has held still, and shows only for that text.
  const openablesId = open && text ? text : null;
  const openablesAsked = useSettled(openablesId, text.length === 1 ? 0 : 80);
  const openables = usePaneFreeServerValue({
    key: openablesAsked === openablesId ? openablesId : null,
    stale: "",
    load: (signal) => searchOpenableResources({ q: text, schemes: null, signal }),
  });
  const openablesSettled = openables.status !== "loading";
  const ownedId = open && text.length >= 2 && openablesSettled ? text : null;
  const ownedAsked = useSettled(ownedId, 160);
  const owned = usePaneFreeServerValue({
    key: ownedAsked === ownedId ? ownedId : null,
    stale: "",
    load: (signal) => {
      const kinds = query.searchQuery.requestedKinds ?? new Set(SEARCH_KINDS);
      return fetchSearchResultPage(
        { ...query.searchQuery, requestedKinds: new Set([...kinds].filter((kind) => kind !== "web")) },
        { limit: 40, cursor: null, signal },
      );
    },
  });
  const ownedSettled = owned.status !== "loading";
  const typedId = openablesId !== null && (text.length === 1 ? openablesSettled : ownedSettled) ? text : null;
  const typed = usePaneFreeServerValue<History>({
    key: typedId === null ? null : `${accountId}:nexus-history:${revision}:${typedId}`,
    stale: "",
    load: (signal) => apiFetch<History>(`/api/me/nexus-history?${new URLSearchParams({ query: text })}`, { signal }),
  });

  const openablesError = openables.status === "failed" ? openables.error : null;
  const ownedError = owned.status === "failed" ? owned.error : null;

  const remoteBusy = (openablesId !== null && !openablesSettled) || (ownedId !== null && !ownedSettled);
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

  /** Record an accepted selection now; a transport failure offers Retry (a retry after a lost answer counts twice). */
  const remember = (selection: Schema<"NexusSelectionRecordRequest">) => {
    const body = JSON.stringify(selection);
    const send = () =>
      apiFetch<ApiJson<"/me/nexus-selections", "post">>("/api/me/nexus-selections", { method: "POST", keepalive: true, body }).then(
        () => {
          feedback.resolve(HISTORY_FEEDBACK_KEY);
          setRevision((value) => value + 1);
        },
        (error: unknown) => {
          if (handleUnauthenticatedApiError(error)) return;
          const content = isApiError(error) ? apiTransportFeedback(error, "Nexus history wasn’t saved") : null;
          if (content === null) {
            // justify-defect: history admits only auth recovery and transport feedback (a stale build too).
            fail({ error });
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
    openables: openables.status === "ready" ? openables.data.items : EMPTY_ITEMS,
    search: owned.status === "ready" ? owned.data.rows : EMPTY_SEARCH,
    openablesReady: openables.status === "ready",
    ownedReady: owned.status === "ready",
    busy: showBusy && remoteBusy,
    pending: remoteBusy,
    failures,
    retry: (source: NexusSource) => (source === "Openables" ? openables : owned).refetch(),
    remember,
  };
}
