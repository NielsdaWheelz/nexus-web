"use client";

// Launcher phases supply complete snapshots; the controller owns display admission.
// Owned writing, including scoped saved passages, comes from the account database;
// local matches lead and readable peer previews retain their remote owner. Unavailable
// local scope inputs are explicit. Exact authored refs resolve locally;
// other exact refs use the existing resource resolver and never enter textual discovery.
import type { SearchFamily } from "@nexus/authored/scope";
import type { AuthoredQuery } from "@nexus/authored/types";
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
import { effectiveSearchKinds, searchHasSemanticFamily } from "@/lib/search/query";
import { SEARCH_READ_TIMEOUT_MS } from "@/lib/search/policy";
import { searchProgress, type SearchProgress } from "@/lib/search/progress";
import { fetchSearchPreview } from "@/lib/search/searchApi";
import { searchQueryToParams } from "@/lib/search/searchParams";
import { WRITING_REF, localResult, localSearchApplies, localSearchScopes, useLocalSearchPreview, type LocalMatch } from "@/lib/search/localSearch";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import type { NexusRecent, NexusSource } from "./model";
import type { NexusQuery } from "./query";

type History = ApiJson<"/me/nexus-history", "get">;
type RetainedLocalTarget = Extract<AuthoredQuery, {kind: "search_admission"}>["targets"][number];

const EMPTY_RECENT: readonly NexusRecent[] = [];
const EMPTY_FRECENCY: Readonly<Record<string, number>> = {};
const EMPTY_LOCAL: readonly LocalMatch[] = [];
/** A remote row's matching passage may be the server's copy of authored text; local owns that. */
const withoutAuthoredPassage = <Row extends { matching_passage: { item: { authored_by_viewer: boolean } } | null }>(row: Row): Row =>
  row.matching_passage && row.matching_passage.item.authored_by_viewer ? { ...row, matching_passage: null } : row;
const PREVIEW_SETTLE_MS = { direct: 80, lexical: 120, hybrid: 160 } as const;
const PREVIEW_PHASE_RANK = { direct: 0, lexical: 1, hybrid: 2 } as const;
const PROGRESS_REVEAL_MS = 150;
export const TRANSPORT_CODES = ["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"];

export function useNexusFind({ open, query, retainedLocalTargets }: { open: boolean; query: NexusQuery; retainedLocalTargets: readonly RetainedLocalTarget[] }) {
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
    key: historyWanted ? `${accountId}:nexus-history` : null,
    stale: String(revision),
    load: (signal) => apiFetch<History>("/api/me/nexus-history", { signal }),
  });

  const referenceRef = query.intent.kind === "Resource" ? query.intent.ref : null;
  const localRef = referenceRef !== null && WRITING_REF.test(referenceRef) ? referenceRef : null;
  const localRead = useAuthoredQuery(open && localRef ? { kind: "resource", ref: localRef } : null);
  const localRow = localRead.data?.rows[0]?.resource ?? null;
  // stable while its row is unchanged; the launcher merges rows on identity.
  const localReference = useMemo(() => localRow?.authored_by_viewer ? localResult(localRow, "") : null, [localRow]);
  const local = useLocalSearchPreview(open && query.intent.kind === "Search" && localSearchApplies(query.searchQuery) ? query.searchQuery.text.trim() : null, query.searchQuery.requestedKinds, query.searchQuery.scope);
  const scopes = localSearchScopes(query.searchQuery.scope);
  const families: SearchFamily[] | null = query.searchQuery.requestedKinds === null ? null : [...query.searchQuery.requestedKinds].filter(kind => kind !== "web").sort();
  const retainedLocal = useAuthoredQuery(open && query.intent.kind === "Search" && retainedLocalTargets.length && scopes !== null && localSearchApplies(query.searchQuery)
    ? { kind: "search_admission", text: query.searchQuery.text.trim(), targets: [...retainedLocalTargets], scopes, families } : null);
  const localValidationReady = query.intent.kind === "Resource" ? localRead.data !== null
    : retainedLocal.data !== null && (local.storeRevision === null || BigInt(retainedLocal.data.store_revision) >= BigInt(local.storeRevision));
  const missingLocal = useMemo(() => {
    if (local.scopeAvailable === false) return new Set(retainedLocalTargets.map(target => target.ref));
    if (!localValidationReady || retainedLocal.data === null) return new Set<string>();
    const present = new Set(retainedLocal.data.rows.map(row => row.resource.ref));
    return new Set(retainedLocalTargets.filter(target => !present.has(target.ref)).map(target => target.ref));
    // The serialized read owns proof of each held field, not just resource presence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localValidationReady, retainedLocal.data, local.scopeAvailable]);
  const reference = usePaneFreeServerValue<ResourceItem>({
    key: open && referenceRef && !localRow?.authored_by_viewer ? `${accountId}:nexus-ref:${referenceRef}` : null,
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
  const directData = directKey !== null && direct.status === "ready" ? direct.data : null;
  const lexicalData = wantsLexical && lexical.status === "ready" ? lexical.data : null;
  const hybridData = wantsHybrid && hybrid.status === "ready" ? hybrid.data : null;
  const best = hybridData ?? lexicalData ?? directData;
  const remotePreview = useMemo(() => {
    if (best === null || best.phase === "direct") return best;
    // Keep proven names across bounded phases, selecting one complete snapshot per ref.
    const names = { exact: 0, prefix: 1, substring: 2 } as const;
    const tier = (row: Schema<"SearchResourceOut">) => row.name_match === null ? 3 : names[row.name_match];
    const winners = new Map<string, Schema<"SearchResourceOut">>();
    const phases = [directData, lexicalData, hybridData].filter(phase => phase !== null);
    for (const phase of phases) for (const row of [...phase.resources, ...phase.saved]) {
      const previous = winners.get(row.item.ref);
      if (!previous || row.item.missing || row.item.activation.kind === "none"
        || previous.item.missing || previous.item.activation.kind === "none"
        || tier(row) <= tier(previous)) winners.set(row.item.ref, row);
    }
    const ordered: Schema<"SearchResourceOut">[] = [];
    const seen = new Set<string>();
    const richerRefs = new Set([...best.resources, ...best.saved].map(row => row.item.ref));
    for (const row of [...best.resources, ...best.saved, ...(directData?.resources ?? []), ...(directData?.saved ?? [])]) {
      if (seen.has(row.item.ref)) continue;
      seen.add(row.item.ref);
      const winner = winners.get(row.item.ref)!;
      if (richerRefs.has(row.item.ref) || winner.name_match !== null) ordered.push(winner);
    }
    return { ...best, resources: ordered.filter(row => row.section !== "saved"), saved: ordered.filter(row => row.section === "saved") };
  }, [best, directData, lexicalData, hybridData]);
  const directSettled = directKey !== null && direct.status !== "loading";
  const lexicalSettled = lexicalKey !== null && lexical.status !== "loading";
  const hybridSettled = hybridKey !== null && hybrid.status !== "loading";
  const typedId = identityKey !== null && (wantsLexical ? lexicalSettled && (!wantsHybrid || hybridSettled) : directSettled) ? text : null;
  const typed = usePaneFreeServerValue<History>({
    key: typedId === null ? null : `${accountId}:nexus-history:${typedId}`,
    stale: String(revision),
    load: signal => apiFetch<History>(historyHref, { signal }),
  });
  // remote search reads synchronized projections; local authored rows are canonical.
  const preview = useMemo(() => remotePreview && { ...remotePreview,
    resources: remotePreview.resources.filter(row => !row.item.authored_by_viewer).map(withoutAuthoredPassage),
    saved: remotePreview.saved.filter(row => !row.item.authored_by_viewer).map(withoutAuthoredPassage),
    passages: remotePreview.passages.filter(row => !row.item.authored_by_viewer) }, [remotePreview]);
  const localShown = useMemo(() => {
    if (!local.matches) return EMPTY_LOCAL;
    const remote = new Set([...preview?.resources ?? [], ...preview?.saved ?? [], ...preview?.passages ?? []].map(row => row.item.ref));
    return local.matches.filter(match => match.resource.authored_by_viewer || !remote.has(match.resource.ref));
  }, [local.matches, preview]);
  const remoteBusy = identityKey !== null && best?.phase !== "hybrid" && ((best?.phase !== "lexical" && !directSettled) || (wantsLexical && !lexicalSettled) || (wantsHybrid && !hybridSettled))
    || (open && referenceRef !== null && localReference === null && reference.status === "loading");
  const localBusy = open && query.intent.kind === "Search" && localSearchApplies(query.searchQuery) && local.matches === null && local.error === null;
  const pending = remoteBusy || localBusy;
  useEffect(() => {
    if (!pending) { setShowBusy(false); return; }
    const timer = window.setTimeout(() => setShowBusy(true), PROGRESS_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [pending, identityKey]);
  const failures = new Set<NexusSource>();
  const retrying = new Set<NexusSource>();
  for (const [source, value, wanted] of [["Direct", direct, identityKey !== null], ["Lexical", lexical, wantsLexical], ["Hybrid", hybrid, wantsHybrid], ["Reference", reference, open && referenceRef !== null && !localRow?.authored_by_viewer]] as const) {
    if (!wanted) continue;
    if (source !== "Reference" && best !== null && PREVIEW_PHASE_RANK[best.phase] > PREVIEW_PHASE_RANK[source === "Direct" ? "direct" : source === "Lexical" ? "lexical" : "hybrid"]) continue;
    if (value.status !== "loading" && value.error) {
      failures.add(source);
      if (value.status === "failed" ? value.retrying : value.refreshing) retrying.add(source);
    }
  }
  const progress = searchProgress({
    phase: best?.phase ?? null, count: localShown.length + (preview === null ? 0 : preview.resources.length + preview.saved.length + preview.passages.length),
    lexical: wantsLexical ? lexical.status === "ready" ? "ready" : lexical.status === "failed" ? "failed" : "pending" : "idle",
    hybrid: wantsHybrid ? hybrid.status === "ready" ? "ready" : hybrid.status === "failed" ? "failed" : "pending" : "idle",
    directFailed: failures.has("Direct"), held: false,
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

  let presentation: SearchProgress = progress;
  if (local.scopeAvailable === false) presentation = { kind: "Notice", text: "scope unavailable on this device. connect to refresh its access and reading data.", action: null };
  else if (local.error || retainedLocal.error || localRead.error) presentation = { kind: "Notice", text: "couldn’t search this device", action: "search" };
  else if (searchUnavailable) presentation = { kind: "Notice", text: "search is unavailable for this input. shorten the search or ask nexus with the full text.", action: null };
  else if (identityKey === null && referenceRef === null || localReference !== null) presentation = { kind: null, text: "", action: null };
  else if (blockedError) presentation = { kind: "Notice", text: blockedError.code === "E_INVALID_REQUEST" ? "this search isn’t valid" : "the search scope is no longer available", action: null };
  else if (localBusy && failures.size === 0) presentation = { kind: "Pending", text: "searching your content…", action: null };
  else if (referenceRef !== null) presentation = reference.status === "failed"
    ? { kind: "Notice", text: "resource lookup failed", action: "search" }
    : { kind: showBusy && remoteBusy ? "Pending" : null, text: showBusy && remoteBusy ? "searching your content…" : "", action: null };
  if (presentation.kind === "Pending" && !showBusy && pending) presentation = { kind: null, text: "", action: null };

  return {
    recent: baseData?.recent ?? EMPTY_RECENT,
    recentRead: {
      status: base.status,
      error: base.status === "loading" ? null : base.error,
      retrying: base.status === "failed" ? base.retrying : base.status === "ready" && base.refreshing,
      retry: base.refetch,
    },
    frecency: typedFrecency ?? baseData?.frecency_by_href ?? EMPTY_FRECENCY,
    preview,
    reference: referenceRef !== null && reference.status === "ready" && !reference.data.authored_by_viewer ? reference.data : null,
    referenceFailed: localReference === null && referenceRef !== null && reference.status === "failed",
    local: localShown,
    missingLocal,
    localValidationReady,
    localReference,
    localReferenceMissing: localRef !== null && localRead.data !== null && !localRow?.authored_by_viewer && reference.status === "ready" && reference.data.authored_by_viewer,
    searchUnavailable,
    progress: presentation,
    retrySearch: () => { if (local.error) local.retry(); if (retainedLocal.error) retainedLocal.retry(); if (localRead.error) localRead.retry(); for (const source of failures) retry(source); },
    retryRelated: () => retry("Hybrid"),
    busy: showBusy && pending,
    pending,
    failures,
    retrying,
    retry,
    remember,
  };
}
