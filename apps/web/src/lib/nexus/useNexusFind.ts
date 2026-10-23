"use client";

// Launcher reads: direct discovery, then content enrichment, then typed history.
// Exact refs use the existing resource resolver and never enter textual discovery.
import { remoteReady } from "@/lib/native/admission";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
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
import type { NexusRecent, NexusSource } from "./model";
import type { NexusQuery } from "./query";

type History = ApiJson<"/me/nexus-history", "get">;

const EMPTY_RECENT: readonly NexusRecent[] = [];
const EMPTY_FRECENCY: Readonly<Record<string, number>> = {};
const HISTORY_FEEDBACK_KEY = "nexus-history-save";
export const TRANSPORT_CODES = ["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"];

export function useNexusFind({ open, query }: { open: boolean; query: NexusQuery }) {
  const { accountId } = useAuthenticatedAccount();
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const [historySave, setHistorySave] = useState<{ content: FeedbackContent; send: () => Promise<void>; commandKey: string; busy: boolean } | null>(null);
  const latestSelection = useRef<(() => Promise<void>) | null>(null);
  useWorkspaceCondition(HISTORY_FEEDBACK_KEY, historySave ? {
    priority: "Write", announcement: "Polite", content: historySave.content,
    actions: [{ label: "retry save", commandKey: historySave.commandKey, onClick: () => void historySave.send(), busy: historySave.busy }],
  } : null);
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
  const reference = usePaneFreeServerValue<ResourceItem>({
    key: open && referenceRef ? `${accountId}:nexus-ref:${referenceRef}` : null,
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
  const preview = directId === null ? null : content.status === "ready" ? content.data : direct.status === "ready" ? direct.data : null;
  const remoteBusy = (directId !== null && (!directSettled || (wantsContent && !contentSettled)))
    || (open && referenceRef !== null && reference.status === "loading");
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
    if (source === "Reference" ? referenceRef === null : directId === null) continue;
    if (value.status !== "loading" && value.error) {
      failures.add(source);
      if (value.status === "failed" ? value.retrying : value.refreshing) retrying.add(source);
    }
  }
  const baseData = base.status === "ready" ? base.data.data : null;
  const typedFrecency = typedId !== null && typed.status === "ready" ? typed.data.data.frecency_by_href : null;

  /** Record an accepted selection now; a transport failure offers Retry (a retry after a lost answer counts twice). */
  const remember = (selection: Schema<"NexusSelectionRecordRequest">) => {
    if (!live.current || !remoteReady()) return;
    const body = JSON.stringify(selection);
    const commandKey = crypto.randomUUID();
    let sending: Promise<void> | null = null;
    const send = (): Promise<void> => {
      if (!live.current) return Promise.resolve();
      if (sending) return sending;
      setHistorySave((current) => current?.send === send ? { ...current, busy: true } : current);
      sending =
      apiFetch<ApiJson<"/me/nexus-selections", "post">>("/api/me/nexus-selections", { method: "POST", keepalive: true, body }).then(
        () => {
          if (!live.current) return;
          if (latestSelection.current === send) setHistorySave(null);
          setRevision((value) => value + 1);
        },
        (error: unknown) => {
          if (!live.current) return;
          if (handleUnauthenticatedApiError(error)) return;
          const content = isApiError(error) ? apiTransportFeedback(error, "recent selection not confirmed") : null;
          if (content === null) {
            // justify-defect: history admits only auth recovery and transport feedback (a stale build too).
            fail({ error });
            return;
          }
          if (latestSelection.current === send) setHistorySave({ content, send, commandKey, busy: false });
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
    reference: referenceRef !== null && reference.status === "ready" ? reference.data : null,
    referenceFailed: referenceRef !== null && reference.status === "failed",
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
