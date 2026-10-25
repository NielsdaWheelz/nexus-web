"use client";

// Launcher reads: local authored matches, direct discovery, then content enrichment,
// then typed history. Notes, pages and highlights come only from the account database;
// remote preview rows for them are dropped. Exact authored refs resolve locally; other
// exact refs use the existing resource resolver and never enter textual discovery.
import { remoteReady } from "@/lib/native/admission";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, apiTransportFeedback, isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue, useSettled, useThrowLater } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { MAX_WORKSPACE_HREF_LENGTH } from "@/lib/workspace/workspaceHref";
import { resolveResourceItem } from "@/lib/resources/items";
import type { ResourceItem } from "@/lib/resources/items";
import { fetchSearchPreview } from "@/lib/search/searchApi";
import { searchQueryToParams } from "@/lib/search/searchParams";
import { AUTHORED_REF, localMatch, localSearchApplies, useLocalSearch, type LocalMatch } from "@/lib/search/localSearch";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import type { NexusRecent, NexusSource } from "./model";
import type { NexusQuery } from "./query";

type History = ApiJson<"/me/nexus-history", "get">;

const EMPTY_RECENT: readonly NexusRecent[] = [];
const EMPTY_FRECENCY: Readonly<Record<string, number>> = {};
const EMPTY_LOCAL: readonly LocalMatch[] = [];
/** A remote row's matching passage may be the server's copy of authored text; local owns that. */
const withoutAuthoredPassage = <Row extends { matching_passage: { item: { ref: string } } | null }>(row: Row): Row =>
  row.matching_passage && AUTHORED_REF.test(row.matching_passage.item.ref) ? { ...row, matching_passage: null } : row;
const LOCAL_PAGES = 1;
export const TRANSPORT_CODES = ["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"];

export function useNexusFind({ open, query }: { open: boolean; query: NexusQuery }) {
  const { accountId } = useAuthenticatedAccount();
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const feedback = useFeedback();
  const latestSelection = useRef<(() => Promise<void>) | null>(null);
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

  const referenceRef = query.intent.kind === "Resource" ? query.intent.ref : null;
  const authoredRef = referenceRef !== null && AUTHORED_REF.test(referenceRef) ? referenceRef : null;
  const localRead = useAuthoredQuery(open && authoredRef ? { kind: "resource", ref: authoredRef } : null);
  const localRow = localRead.data?.rows[0]?.resource ?? null;
  // stable while its row is unchanged; the launcher merges rows on identity.
  const localReference = useMemo(() => authoredRef && localRow ? localMatch(localRow, "") : null, [authoredRef, localRow]);
  const local = useLocalSearch(open && query.intent.kind === "Search" && localSearchApplies(query.searchQuery) ? query.searchQuery.text.trim() : null, query.searchQuery.requestedKinds, LOCAL_PAGES);
  const reference = usePaneFreeServerValue<ResourceItem>({
    key: open && referenceRef && !authoredRef ? `${accountId}:nexus-ref:${referenceRef}` : null,
    stale: "",
    load: (signal) => resolveResourceItem(referenceRef!, signal),
  });
  const params = searchQueryToParams(query.searchQuery);
  const identity = params.toString();
  params.delete("view");
  params.set("phase", "content");
  const previewHref = `/api/search/preview?${params}`;
  const historyHref: `/api/${string}` = `/api/me/nexus-history?${new URLSearchParams({ query: text })}`;
  // Search must fit both its GET transports and its eventual workspace address.
  // Explicit authoring commands never send their arguments through discovery.
  const supported = previewHref.length <= MAX_WORKSPACE_HREF_LENGTH &&
    historyHref.length <= MAX_WORKSPACE_HREF_LENGTH && `/search?${identity}`.length <= MAX_WORKSPACE_HREF_LENGTH;
  const searchUnavailable = open && text !== "" && query.intent.kind === "Search" && !supported;
  const queryLength = Array.from(query.searchQuery.text.trim()).length;
  const directId = open && text && query.intent.kind === "Search" && supported ? `${accountId}:nexus-preview:${identity}` : null;
  const directAsked = useSettled(directId, queryLength === 1 ? 0 : 80);
  const directKey = directAsked === directId ? directId : null;
  const direct = usePaneFreeServerValue({
    readPolicy: "search:direct",
    key: directKey,
    stale: "",
    load: (signal) => fetchSearchPreview(query.searchQuery, { phase: "direct", signal }),
  });
  const directSettled = directKey !== null && direct.status !== "loading";
  const wantsContent = directId !== null && queryLength >= 2;
  const contentId = wantsContent && directSettled ? directId : null;
  const contentAsked = useSettled(contentId, 160);
  const content = usePaneFreeServerValue({
    readPolicy: "search:content",
    key: contentAsked === contentId ? contentId : null,
    stale: "",
    load: (signal) => fetchSearchPreview(query.searchQuery, { phase: "content", signal }),
  });
  const contentSettled = contentId !== null && content.status !== "loading";
  const typedId = directId !== null && (wantsContent ? contentSettled : directSettled) ? text : null;
  const typed = usePaneFreeServerValue<History>({
    key: typedId === null ? null : `${accountId}:nexus-history:${revision}:${typedId}`,
    stale: "",
    load: (signal) => apiFetch<History>(historyHref, { signal }),
  });
  const remotePreview = directId === null ? null : content.status === "ready" ? content.data : direct.status === "ready" ? direct.data : null;
  // remote search reads synchronized projections; local authored rows are canonical.
  const preview = remotePreview && { ...remotePreview,
    resources: remotePreview.resources.filter(row => !AUTHORED_REF.test(row.item.ref)).map(withoutAuthoredPassage),
    saved: remotePreview.saved.filter(row => !AUTHORED_REF.test(row.item.ref)).map(withoutAuthoredPassage),
    passages: remotePreview.passages.filter(row => !AUTHORED_REF.test(row.item.ref)) };
  const remoteBusy = (directId !== null && (!directSettled || (wantsContent && !contentSettled)))
    || (open && referenceRef !== null && !authoredRef && reference.status === "loading");
  useEffect(() => {
    if (!remoteBusy) {
      setShowBusy(false);
      return;
    }
    const timer = window.setTimeout(() => setShowBusy(true), 150);
    return () => window.clearTimeout(timer);
  }, [remoteBusy]);

  const failures = new Set<NexusSource>();
  const retrying = new Set<NexusSource>();
  for (const [source, value] of [["Direct", direct], ["Content", content], ["Reference", reference]] as const) {
    if (source === "Direct" && content.status === "ready" && content.error === null) continue;
    if (source === "Reference" ? referenceRef === null || authoredRef !== null : directId === null) continue;
    if (value.status !== "loading" && value.error) {
      failures.add(source);
      if (value.status === "failed" ? value.retrying : value.refreshing) retrying.add(source);
    }
  }
  const baseData = base.status === "ready" ? base.data.data : null;
  const typedFrecency = typedId !== null && typed.status === "ready" ? typed.data.data.frecency_by_href : null;

  /** Record an accepted selection now; a transport failure offers one retry (a retry after a lost answer counts twice). */
  const remember = (selection: Schema<"NexusSelectionRecordRequest">) => {
    if (!live.current || !remoteReady()) return;
    const body = JSON.stringify(selection);
    let sending: Promise<void> | null = null;
    const send = (): Promise<void> => {
      if (!live.current) return Promise.resolve();
      if (sending) return sending;
      sending =
      apiFetch<ApiJson<"/me/nexus-selections", "post">>("/api/me/nexus-selections", { method: "POST", keepalive: true, body }).then(
        () => { if (live.current) setRevision((value) => value + 1); },
        (error: unknown) => {
          if (!live.current) return;
          if (handleUnauthenticatedApiError(error)) return;
          const content = isApiError(error) ? apiTransportFeedback(error, "recent selection not confirmed") : null;
          if (content === null) {
            // justify-defect: history admits only auth recovery and transport feedback (a stale build too).
            fail({ error });
            return;
          }
          if (latestSelection.current === send) feedback.receipt(content, { label: "retry save", onClick: () => void send() });
        },
      ).finally(() => { sending = null; });
      return sending;
    };
    latestSelection.current = send;
    void send();
  };

  return {
    recent: baseData?.recent ?? EMPTY_RECENT,
    frecency: typedFrecency ?? baseData?.frecency_by_href ?? EMPTY_FRECENCY,
    preview,
    reference: !authoredRef && referenceRef !== null && reference.status === "ready" ? reference.data : null,
    referenceFailed: !authoredRef && referenceRef !== null && reference.status === "failed",
    /** Local authored matches for the typed text; the launcher places them before remote rows. */
    local: local.matches ?? EMPTY_LOCAL,
    /** An exact authored ref resolved on this device; null while reading or when absent. */
    localReference,
    /** The local read finished and this device has no such resource. */
    localReferenceMissing: authoredRef !== null && localRead.data !== null && localRow === null,
    semanticUnavailable: preview?.semantic_status === "unavailable",
    searchUnavailable,
    busy: showBusy && remoteBusy,
    pending: remoteBusy,
    failures,
    retrying,
    retry: (source: NexusSource) => ({ Direct: direct, Content: content, Reference: reference })[source].refetch(),
    remember,
  };
}
