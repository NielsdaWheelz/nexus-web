"use client";

// One account owns live refresh/research submissions. Retries send the original
// bytes; dismissal forgets uncertainty without cancelling accepted server work.
// Only the captured, still-current entry may settle itself. Canonical reads are
// invalidated after every sent attempt while the original account remains active.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiFetch,
  apiTransportFeedback,
  isApiError,
  isStaleBuild,
  isUnauthenticatedApiError,
  outcomeUnknown,
  requestWithDeadline,
  STALE_BUILD_FEEDBACK,
  type ApiError,
} from "@/lib/api/client";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { publishImportsInvalidation } from "@/lib/imports/api";
import {
  observeMetadataAdmission,
  reconnectMetadataOperations,
  startMetadataAccount,
} from "@/lib/media/mediaMetadataOperations";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { resolveResourceItem } from "@/lib/resources/items";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace } from "@/lib/workspace/store";

export type AdmissionIntent =
  | { kind: "SourceRefresh"; mediaId: string; request: Schema<"RefreshSourceRequest"> }
  | { kind: "MetadataResearch"; mediaId: string; request: Schema<"MetadataEnrichmentRequest"> };
export type AdmissionResult =
  | { kind: "Accepted" }
  | { kind: "Pending"; key: string }
  | { kind: "LocalFailure"; content: FeedbackContent }
  | { kind: "OwnerGone" };
interface AdmissionEntry {
  readonly key: string;
  readonly intent: AdmissionIntent;
  kind: "sending" | "unconfirmed";
  error: ApiError | null;
}
interface LiveEntry extends AdmissionEntry {
  readonly body: string;
  readonly unregister: () => void;
}
const EMPTY: readonly AdmissionEntry[] = [];

function definiteRefusal(intent: AdmissionIntent, error: ApiError): boolean {
  if (error.status === 404 && error.code === "E_MEDIA_NOT_FOUND") return true;
  if (error.status === 403)
    return error.code === (intent.kind === "SourceRefresh" ? "E_OWNER_REQUIRED" : "E_FORBIDDEN");
  return error.status === 409 &&
    (error.code === "E_RESOURCE_CONFLICT" || error.code === "E_RETRY_NOT_ALLOWED" ||
      (intent.kind === "SourceRefresh" && error.code === "E_REPAIR_NOT_ALLOWED"));
}

function refusalContent(intent: AdmissionIntent, error: ApiError): FeedbackContent {
  const subject = intent.kind === "SourceRefresh" ? "source refresh" : "metadata request";
  const message = error.code === "E_MEDIA_NOT_FOUND"
    ? "this item is no longer available to this account."
    : error.code === "E_OWNER_REQUIRED" || error.code === "E_FORBIDDEN"
      ? "only the item's owner can start this work."
      : error.code === "E_RESOURCE_CONFLICT"
        ? "this item changed. review its current state before starting another request."
        : error.code === "E_REPAIR_NOT_ALLOWED"
          ? "the published document can't be replaced by this request."
          : "this work can't start in the item's current state. review its current status.";
  return { tone: "Warning", title: `${subject} not started`, message, requestId: error.requestId };
}

function createAdmissions(accountId: string, guard: WorkGuard) {
  const entries = new Map<string, LiveEntry>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  let lifetime: AbortController | null = null;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const publish = () => {
    snapshot = [...entries.values()];
    for (const listener of listeners) listener();
  };
  const live = (scope: AbortController) => lifetime === scope && !scope.signal.aborted;
  const current = (entry: LiveEntry, scope: AbortController) =>
    live(scope) && entries.get(entry.key) === entry;
  const retire = (entry: LiveEntry) => {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    entry.unregister();
    publish();
  };

  async function send(entry: LiveEntry, fresh: boolean, scope: AbortController): Promise<AdmissionResult> {
    if (!current(entry, scope)) return { kind: "OwnerGone" };
    entry.kind = "sending";
    entry.error = null;
    publish();
    const { intent } = entry;
    try {
      const accepted = await requestWithDeadline({
        signal: scope.signal,
        timeoutMs: 30_000,
        request: async signal => {
          if (intent.kind === "SourceRefresh") {
            await apiFetch<ApiJson<"/media/{media_id}/refresh", "post">>(
              `/api/media/${encodeURIComponent(intent.mediaId)}/refresh`,
              { method: "POST", body: entry.body, signal },
            );
            return null;
          }
          const { data } = await apiFetch<ApiJson<"/media/{media_id}/metadata-enrichment", "post">>(
            `/api/media/${encodeURIComponent(intent.mediaId)}/metadata-enrichment`,
            { method: "POST", body: entry.body, signal },
          );
          return data;
        },
      });
      if (!current(entry, scope)) return { kind: "OwnerGone" };
      if (accepted !== null) observeMetadataAdmission(intent.mediaId, accepted.last_enriched_at);
      retire(entry);
      return { kind: "Accepted" };
    } catch (error) {
      if (!current(entry, scope)) return { kind: "OwnerGone" };
      entry.kind = "unconfirmed";
      entry.error = isApiError(error) ? error : null;
      publish();
      if (isUnauthenticatedApiError(error)) {
        handleUnauthenticatedApiError(error);
        return { kind: "Pending", key: entry.key };
      }
      if (isAbortError(error) || outcomeUnknown(error)) return { kind: "Pending", key: entry.key };
      if (isApiError(error) && (definiteRefusal(intent, error) || isStaleBuild(error) || error.code === "E_RATE_LIMITED")) {
        if (!fresh) return { kind: "Pending", key: entry.key };
        const content = apiTransportFeedback(error, "request not started") ?? refusalContent(intent, error);
        retire(entry);
        return { kind: "LocalFailure", content };
      }
      // The existing defect boundary owns unexpected replies; uncertainty remains
      // registered until explicit dismissal or account teardown.
      throw error;
    } finally {
      if (live(scope)) {
        if (intent.kind === "MetadataResearch") reconnectMetadataOperations(intent.mediaId);
        publishImportsInvalidation();
      }
    }
  }

  return {
    subscribe,
    getSnapshot: () => snapshot,
    start() {
      const scope = new AbortController();
      lifetime = scope;
      return () => {
        scope.abort();
        if (lifetime !== scope) return;
        lifetime = null;
        for (const entry of entries.values()) entry.unregister();
        entries.clear();
        publish();
      };
    },
    pending: (kind: AdmissionIntent["kind"], mediaId: string) =>
      snapshot.find(entry => entry.intent.kind === kind && entry.intent.mediaId === mediaId) ?? null,
    admit(original: AdmissionIntent): Promise<AdmissionResult> {
      const scope = lifetime;
      if (scope === null || !live(scope)) return Promise.resolve({ kind: "OwnerGone" });
      const key = `media-admission:${accountId}:${original.kind}:${original.mediaId}`;
      if (entries.has(key)) return Promise.resolve({ kind: "Pending", key });
      const intent: AdmissionIntent = original.kind === "SourceRefresh"
        ? { ...original, request: { expected_attempt_id: original.request.expected_attempt_id } }
        : { ...original, request: { expected_job_id: original.request.expected_job_id } };
      const entry: LiveEntry = {
        key, intent, body: JSON.stringify(intent.request), kind: "sending", error: null,
        unregister: guard.register({
          id: key,
          scope: { kind: "account" },
          read: () => ({ changed: false, unconfirmed: true, stopsBrowserWork: false }),
          subscribe,
        }),
      };
      entries.set(key, entry);
      return send(entry, true, scope);
    },
    async retry(key: string): Promise<void> {
      const scope = lifetime;
      const entry = entries.get(key);
      if (scope === null || entry === undefined || entry.kind === "sending" || isStaleBuild(entry.error)) return;
      await send(entry, false, scope);
    },
    forget(key: string): void {
      const entry = entries.get(key);
      if (entry !== undefined && guard.confirmLoss({ scopes: [], ownerIds: [entry.key] })) retire(entry);
    },
  };
}

const Context = createContext<ReturnType<typeof createAdmissions> | null>(null);

export function MediaAdmissionsProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const guard = useWorkGuard();
  const owner = useMemo(() => createAdmissions(accountId, guard), [accountId, guard]);
  useLayoutEffect(() => {
    const stopMetadata = startMetadataAccount(accountId);
    const stopAdmissions = owner.start();
    return () => { stopAdmissions(); stopMetadata(); };
  }, [accountId, owner]);
  return <Context value={owner}>{children}</Context>;
}

function useOwner() {
  const owner = useContext(Context);
  if (owner === null) throw new Error("MediaAdmissionsProvider is missing");
  return owner;
}

export function useMediaAdmissions() {
  const owner = useOwner();
  useSyncExternalStore(owner.subscribe, owner.getSnapshot, () => EMPTY);
  return { admit: owner.admit, retry: owner.retry, pending: owner.pending, forget: owner.forget };
}

export function MediaAdmissionsHost() {
  const owner = useOwner();
  const entries = useSyncExternalStore(owner.subscribe, owner.getSnapshot, () => EMPTY);
  return entries.map(entry => <AdmissionCondition key={entry.key} entry={entry} />);
}

function AdmissionCondition({ entry }: { entry: AdmissionEntry }) {
  const owner = useMediaAdmissions();
  const online = useConnectivity() === "Online";
  const fail = useThrowLater();
  const workspace = useLatestWorkspace();
  const resource = usePaneFreeServerValue({
    key: `admission-resource:${entry.intent.mediaId}`,
    stale: "",
    load: signal => resolveResourceItem(`media:${entry.intent.mediaId}`, signal),
  });
  const label = resource.status === "ready" && !resource.data.missing ? resource.data.label : null;
  const subject = entry.intent.kind === "SourceRefresh" ? "source refresh" : "metadata request";
  const title = entry.kind === "sending" ? `sending ${subject}` : `${subject}: request unconfirmed`;
  useWorkspaceCondition(`media-admission:${entry.key}`, {
    priority: "Write",
    content: isStaleBuild(entry.error) ? STALE_BUILD_FEEDBACK : {
      tone: entry.kind === "sending" ? "Neutral" : "Warning",
      title: label === null ? title : `${title} · ${label}`,
      message: entry.kind === "sending" ? undefined : "the request may already have started work. retry sends the same request. accepted server work is not cancelled.",
      requestId: entry.error?.requestId,
    },
    announcement: "Polite",
    actions: [
      { label: "retry same request", busy: entry.kind === "sending", disabledReason: online ? undefined : "this request needs a connection", onClick: () => { void owner.retry(entry.key).catch(error => fail({ error })); } },
      { label: "dismiss", onClick: () => owner.forget(entry.key) },
    ],
    returnFocus: () => findPaneLandmarkFocusTarget(workspace().state.active_primary_pane_id),
  });
  return null;
}
