"use client";

// One account owns live refresh/research submissions. Retries send the original
// bytes. An unconfirmed attempt holds a slip until it is accepted or forgotten.
// Only the captured, still-current entry may settle itself. Canonical reads are
// invalidated after every sent attempt while the original account remains active.
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Hold, useOutcome, type FeedbackContent } from "@/components/feedback/Feedback";
import { transportVerbs, type Line, type Verbs } from "@/components/feedback/stage";
import { remoteAdmission, remoteReady } from "@/lib/native/admission";
import type { RemoteAdmission } from "@/lib/native/contracts";
import {
  apiFetch,
  isApiError,
  isStaleBuild,
  isUnauthenticatedApiError,
  outcomeUnknown,
  requestWithDeadline,
  type ApiError,
} from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf, type Transport } from "@/lib/api/failure";
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

export type AdmissionIntent =
  | { kind: "SourceRefresh"; mediaId: string; request: Schema<"RefreshSourceRequest"> }
  | { kind: "MetadataResearch"; mediaId: string; request: Schema<"MetadataEnrichmentRequest"> };
export type AdmissionResult =
  | { kind: "Accepted" }
  | { kind: "Pending"; key: string }
  /** Nothing started. `error` is set where its transport says why (`fail` it with `line.fact`);
   * otherwise `line` and `verbs` are the whole of it. `content` is the same line for the
   * resource-action runtime until L7. */
  | { kind: "LocalFailure"; line: Line; verbs: Verbs | null; error: ApiError | null; content: FeedbackContent }
  | { kind: "OwnerGone" };
interface AdmissionEntry {
  readonly key: string;
  readonly intent: AdmissionIntent;
  kind: "sending" | "unconfirmed";
  error: ApiError | null;
  /** Unconfirmed outcomes so far; each one speaks again. */
  unconfirmed: number;
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

const FACT: Readonly<Record<AdmissionIntent["kind"], string>> = {
  SourceRefresh: "couldn’t refresh the source.",
  MetadataResearch: "couldn’t start the metadata search.",
};

function refusalReason(error: ApiError): string {
  switch (error.code) {
    case "E_MEDIA_NOT_FOUND": return "this item isn’t available to you.";
    case "E_OWNER_REQUIRED":
    case "E_FORBIDDEN": return "only the item’s owner can do this.";
    case "E_RESOURCE_CONFLICT": return "this item changed.";
    case "E_REPAIR_NOT_ALLOWED": return "its published text can’t be replaced.";
    default: return "it can’t start in this item’s current state.";
  }
}

/** What a request would meet now, from admission alone: signed out, stale, or unreachable. */
export function admissionTransport(admission: RemoteAdmission): Transport {
  if (admission === "SignInRequired") return "SignIn";
  if (admission === "UpdateRequired") return "Update";
  return navigator.onLine === false ? "Offline" : "Unavailable";
}

function localFailure(line: Line, verbs: Verbs | null, error: ApiError | null): AdmissionResult {
  return { kind: "LocalFailure", line, verbs, error, content: { tone: "Warning", title: line.fact, message: line.reason } };
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
      entry.unconfirmed += 1;
      publish();
      if (isUnauthenticatedApiError(error)) {
        handleUnauthenticatedApiError(error);
        return { kind: "Pending", key: entry.key };
      }
      if (isAbortError(error) || outcomeUnknown(error)) return { kind: "Pending", key: entry.key };
      if (isApiError(error) && (definiteRefusal(intent, error) || isStaleBuild(error) || error.code === "E_RATE_LIMITED")) {
        if (!fresh) return { kind: "Pending", key: entry.key };
        retire(entry);
        return definiteRefusal(intent, error) ? localFailure({ fact: FACT[intent.kind], reason: refusalReason(error) }, null, null)
          : localFailure(TRANSPORT_LINES[transportOf(error)].command(FACT[intent.kind]), null, error);
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
      if (!remoteReady()) {
        const transport = admissionTransport(remoteAdmission());
        return Promise.resolve(localFailure(TRANSPORT_LINES[transport].command(FACT[original.kind]), transportVerbs(transport, { signIn: null }), null));
      }
      const scope = lifetime;
      if (scope === null || !live(scope)) return Promise.resolve({ kind: "OwnerGone" });
      const key = `media-admission:${accountId}:${original.kind}:${original.mediaId}`;
      if (entries.has(key)) return Promise.resolve({ kind: "Pending", key });
      const intent: AdmissionIntent = original.kind === "SourceRefresh"
        ? { ...original, request: { expected_attempt_id: original.request.expected_attempt_id } }
        : { ...original, request: { expected_job_id: original.request.expected_job_id } };
      const entry: LiveEntry = {
        key, intent, body: JSON.stringify(intent.request), kind: "sending", error: null, unconfirmed: 0,
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

/** Each unconfirmed attempt holds one slip until it is accepted or forgotten, even after its
 * initiator closed. A stale build's refusal is said once instead: reload is its only remedy. */
export function MediaAdmissionsHost() {
  const owner = useOwner();
  const entries = useSyncExternalStore(owner.subscribe, owner.getSnapshot, () => EMPTY);
  return entries.map(entry => <AdmissionReport key={entry.key} entry={entry} />);
}

function AdmissionReport({ entry }: { entry: AdmissionEntry }) {
  const owner = useMediaAdmissions();
  const online = useConnectivity() === "Online";
  const throwLater = useThrowLater();
  const { fail } = useOutcome();
  const resource = usePaneFreeServerValue({
    key: `admission-resource:${entry.intent.mediaId}`,
    stale: "",
    load: signal => resolveResourceItem(`media:${entry.intent.mediaId}`, signal),
  });
  const label = resource.status === "ready" && !resource.data.missing ? resource.data.label : null;
  const stale = isStaleBuild(entry.error) ? entry.error : null;
  const fact = FACT[entry.intent.kind];
  useEffect(() => stale === null ? undefined : fail(stale, fact), [fact, fail, stale]);
  if (entry.unconfirmed === 0 || stale !== null) return null;
  const subject = entry.intent.kind === "SourceRefresh" ? "the source refresh" : "the metadata search";
  return <Hold id={entry.key} attempt={entry.unconfirmed}
    line={{ fact: label === null ? `not sure ${subject} started.` : `not sure ${subject} started for “${label}”.`, reason: "it may have gone through." }}
    verbs={[{ label: "retry", commandKey: `retry ${entry.key}`, busy: entry.kind === "sending", disabledReason: online ? undefined : "you’re offline.",
      run: () => { void owner.retry(entry.key).catch(error => throwLater({ error })); } }]} />;
}
