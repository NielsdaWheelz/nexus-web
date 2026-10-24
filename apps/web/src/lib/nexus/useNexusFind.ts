"use client";

// Launcher phases settle independently; interaction holds a later complete response.
// Exact refs use the existing resource resolver and never enter textual discovery.
import { remoteReady } from "@/lib/native/admission";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, apiTransportFeedback, isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue, useSettled, useThrowLater } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { MAX_WORKSPACE_HREF_LENGTH } from "@/lib/workspace/workspaceHref";
import { resolveResourceItem } from "@/lib/resources/items";
import type { ResourceItem } from "@/lib/resources/items";
import { effectiveSearchKinds, searchHasSemanticFamily } from "@/lib/search/query";
import { SEARCH_READ_TIMEOUT_MS } from "@/lib/search/policy";
import { searchProgress } from "@/lib/search/progress";
import { fetchSearchPreview, type PreviewPhase } from "@/lib/search/searchApi";
import { searchQueryToParams } from "@/lib/search/searchParams";
import type { NexusRecent, NexusSource } from "./model";
import type { NexusQuery } from "./query";

type History = ApiJson<"/me/nexus-history", "get">;

const EMPTY_RECENT: readonly NexusRecent[] = [];
const EMPTY_FRECENCY: Readonly<Record<string, number>> = {};
const HISTORY_FEEDBACK_KEY = "nexus-history-save";
const PREVIEW_SETTLE_MS = { direct: 80, lexical: 120, hybrid: 160 } as const;
const PREVIEW_PHASE_RANK = { direct: 0, lexical: 1, hybrid: 2 } as const;
const PROGRESS_REVEAL_MS = 150;
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
    needsAttention: true,
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
  params.set("phase", "lexical");
  const previewHref = `/api/search/preview?${params}`;
  const historyHref: `/api/${string}` = `/api/me/nexus-history?${new URLSearchParams({ query: text })}`;
  // Search must fit both its GET transports and its eventual workspace address.
  // Explicit authoring commands never send their arguments through discovery.
  const supported = previewHref.length <= MAX_WORKSPACE_HREF_LENGTH &&
    historyHref.length <= MAX_WORKSPACE_HREF_LENGTH && `/search?${identity}`.length <= MAX_WORKSPACE_HREF_LENGTH;
  const searchUnavailable = open && text !== "" && query.intent.kind === "Search" && !supported;
  const queryLength = Array.from(query.searchQuery.text.trim()).length;
  const identityKey = open && text && query.intent.kind === "Search" && supported && effectiveSearchKinds(query.searchQuery).some(kind => kind !== "web") ? `${accountId}:nexus-preview:${identity}` : null;
  const directAsked = useSettled(identityKey, PREVIEW_SETTLE_MS.direct);
  const lexicalAsked = useSettled(identityKey, PREVIEW_SETTLE_MS.lexical);
  const hybridAsked = useSettled(identityKey, PREVIEW_SETTLE_MS.hybrid);
  const wantsLexical = identityKey !== null && queryLength >= 2;
  const wantsHybrid = wantsLexical && searchHasSemanticFamily(query.searchQuery);
  const [attempts, setAttempts] = useState({ direct: 0, lexical: 0, hybrid: 0 });
  const directKey = identityKey !== null && (queryLength === 1 || directAsked === identityKey) ? `${identityKey}:direct:${attempts.direct}` : null;
  const lexicalKey = wantsLexical && lexicalAsked === identityKey ? `${identityKey}:lexical:${attempts.lexical}` : null;
  const hybridKey = wantsHybrid && hybridAsked === identityKey ? `${identityKey}:hybrid:${attempts.hybrid}` : null;
  const direct = usePaneFreeServerValue({
    key: directKey, stale: "", readPolicy: "search:direct", retry: "manual", timeoutMs: SEARCH_READ_TIMEOUT_MS.direct,
    load: signal => fetchSearchPreview(query.searchQuery, { phase: "direct", signal }),
  });
  const lexical = usePaneFreeServerValue({
    key: lexicalKey, stale: "", readPolicy: "search:lexical", retry: "manual", timeoutMs: SEARCH_READ_TIMEOUT_MS.lexical,
    load: signal => fetchSearchPreview(query.searchQuery, { phase: "lexical", signal }),
  });
  const hybrid = usePaneFreeServerValue({
    key: hybridKey, stale: "", readPolicy: "search:hybrid", retry: "manual", timeoutMs: SEARCH_READ_TIMEOUT_MS.hybrid,
    load: signal => fetchSearchPreview(query.searchQuery, { phase: "hybrid", signal }),
  });
  type Accepted = { identity: string | null; phase: PreviewPhase; data: Schema<"SearchPreviewResponse"> };
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const latched = useRef(false);
  const currentIdentity = useRef(identityKey);
  if (currentIdentity.current !== identityKey) {
    currentIdentity.current = identityKey;
    latched.current = false;
  }
  const shown = accepted?.identity === identityKey ? accepted : null;
  const best = wantsHybrid && hybrid.status === "ready" ? hybrid.data : wantsLexical && lexical.status === "ready" ? lexical.data : directKey !== null && direct.status === "ready" ? direct.data : null;
  useLayoutEffect(() => {
    if (best === null || identityKey !== currentIdentity.current) return;
    if (shown !== null && PREVIEW_PHASE_RANK[best.phase] < PREVIEW_PHASE_RANK[shown.phase]) return;
    if (latched.current && (shown === null || best.phase !== shown.phase)) return;
    if (shown?.data !== best) setAccepted({ identity: identityKey, phase: best.phase, data: best });
  }, [best, identityKey, shown]);
  const held = best !== null && (shown === null ? latched.current : PREVIEW_PHASE_RANK[best.phase] > PREVIEW_PHASE_RANK[shown.phase]);
  const interact = useCallback(() => { latched.current = true; }, []);
  const refresh = () => {
    if (best === null || currentIdentity.current !== identityKey) return;
    latched.current = false;
    setAccepted({ identity: identityKey, phase: best.phase, data: best });
  };
  const directSettled = directKey !== null && direct.status !== "loading";
  const lexicalSettled = lexicalKey !== null && lexical.status !== "loading";
  const hybridSettled = hybridKey !== null && hybrid.status !== "loading";
  const typedId = identityKey !== null && (wantsLexical ? lexicalSettled && (!wantsHybrid || hybridSettled) : directSettled) ? text : null;
  const typed = usePaneFreeServerValue<History>({
    key: typedId === null ? null : `${accountId}:nexus-history:${revision}:${typedId}`,
    stale: "",
    load: signal => apiFetch<History>(historyHref, { signal }),
  });
  const preview = shown?.data ?? null;
  const remoteBusy = identityKey !== null && shown?.phase !== "hybrid" && ((shown?.phase !== "lexical" && !directSettled) || (wantsLexical && !lexicalSettled) || (wantsHybrid && !hybridSettled))
    || (open && referenceRef !== null && reference.status === "loading");
  useEffect(() => {
    if (!remoteBusy) { setShowBusy(false); return; }
    const timer = window.setTimeout(() => setShowBusy(true), PROGRESS_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [remoteBusy, identityKey]);
  const failures = new Set<NexusSource>();
  const retrying = new Set<NexusSource>();
  for (const [source, value, wanted] of [["Direct", direct, identityKey !== null], ["Lexical", lexical, wantsLexical], ["Hybrid", hybrid, wantsHybrid], ["Reference", reference, open && referenceRef !== null]] as const) {
    if (!wanted) continue;
    if (source !== "Reference" && shown !== null && PREVIEW_PHASE_RANK[shown.phase] > PREVIEW_PHASE_RANK[source === "Direct" ? "direct" : source === "Lexical" ? "lexical" : "hybrid"]) continue;
    if (value.status !== "loading" && value.error) {
      failures.add(source);
      if (value.status === "failed" ? value.retrying : value.refreshing) retrying.add(source);
    }
  }
  const progress = searchProgress({
    phase: shown?.phase ?? null, count: preview === null ? 0 : preview.resources.length + preview.saved.length + preview.passages.length,
    lexical: wantsLexical ? lexical.status === "ready" ? "ready" : lexical.status === "failed" ? "failed" : "pending" : "idle",
    hybrid: wantsHybrid ? hybrid.status === "ready" ? "ready" : hybrid.status === "failed" ? "failed" : "pending" : "idle",
    directFailed: failures.has("Direct"), held,
  });
  const blocked = [...failures].map(source => ({ Direct: direct, Lexical: lexical, Hybrid: hybrid, Reference: reference })[source]).find(value => value.status !== "loading" && value.error !== null && ["E_INVALID_REQUEST", "E_NOT_FOUND", "E_CONVERSATION_NOT_FOUND"].includes(value.error.code));
  const blockedError = blocked?.status !== "loading" ? blocked?.error : null;
  const retry = (source: NexusSource) => {
    if (source === "Reference") { reference.refetch(); return; }
    const phase = source === "Direct" ? "direct" : source === "Lexical" ? "lexical" : "hybrid";
    setAttempts(current => ({ ...current, [phase]: current[phase] + 1 }));
  };
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
    searchUnavailable,
    progress: {
      text: searchUnavailable ? "search is unavailable for this input. shorten the search or ask nexus with the full text." : identityKey === null && referenceRef === null ? "" : blockedError ? blockedError.code === "E_INVALID_REQUEST" ? "this search isn’t valid" : "the search scope is no longer available" : referenceRef !== null ? reference.status === "failed" ? "resource lookup failed" : showBusy && remoteBusy ? "searching your content…" : "" : remoteBusy && !showBusy && progress.action === null ? "" : progress.text,
      action: searchUnavailable ? null : identityKey === null && referenceRef === null ? null : blockedError ? null : referenceRef !== null ? reference.status === "failed" ? "search" as const : null : progress.action,
    },
    interact,
    refresh,
    retrySearch: () => { for (const source of failures) retry(source); },
    retryRelated: () => retry("Hybrid"),
    busy: showBusy && remoteBusy,
    pending: remoteBusy,
    failures,
    retrying,
    retry,
    remember,
  };
}
