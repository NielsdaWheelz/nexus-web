"use client";

/**
 * The one owner of the viewer's Lectern snapshot and of every Lectern and consumption command.
 *
 * One promise chain serializes commands and refetches, so installs never interleave: a GET
 * queued before a command cannot overwrite that command's answer. Each call mints its own
 * `clientMutationId` (natural-end settles bring theirs). Ensure retains its exact command
 * until acknowledgement and bounds each attempt; other failed commands refetch and rethrow.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  ApiError,
} from "@/lib/api/client";
import { useFeedback } from "@/components/feedback/Feedback";
import { createRandomId } from "@/lib/createRandomId";
import { assertNever } from "@/lib/assertNever";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import {
  findPaneChromeFocusTarget,
  findPaneCollectionRowFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { useWorkspaceStore } from "@/lib/workspace/store";
import {
  consumptionResultFromWire,
  lecternSnapshotFromWire,
  parseLecternItemId,
  type ConsumptionResult,
  type FinishId,
  type LecternItemId,
  type LecternResult,
  type LecternSnapshot,
  type MediaId,
  type MediaProgressState,
  type NaturalEnd,
  type Placement,
  type UndoRestore,
} from "@/lib/lectern/contract";

const REVALIDATE_MIN_INTERVAL_MS = 60_000;

type CanonicalInstallEvent =
  | { kind: "ensureAcknowledged"; mediaId: MediaId }
  | { kind: "progressState"; state: MediaProgressState }
  | { kind: "snapshot"; snapshot: LecternSnapshot; unreadMediaIds: readonly MediaId[] };
type CanonicalInstallListener = (event: CanonicalInstallEvent) => void | Promise<void>;

export type EnsureRequest =
  | { kind: "Sending" | "Checking" }
  | { kind: "Unconfirmed"; check(): void };
type EnsureOutcome = "Acknowledged" | "Unconfirmed";
interface PendingEnsure {
  readonly mediaId: MediaId;
  readonly title: string;
  readonly command: Schema<"EnsureItemCommand">;
  readonly check: () => void;
  state: EnsureRequest;
  attempt: Promise<EnsureOutcome> | null;
}

/**
 * The Lectern read: loading, the snapshot, or what failed with its retry (a
 * defect too, which the Lectern pane throws).
 */
export type LecternRead =
  | { status: "loading" }
  | { status: "ready"; data: LecternSnapshot }
  | { status: "error"; error: unknown; retry: () => void };

export interface LecternCapability {
  readonly resource: LecternRead;
  /** A command is in flight. */
  readonly busy: boolean;
  readonly ensureRequests: ReadonlyMap<MediaId, EnsureRequest>;
  ensureItem(input: { mediaId: MediaId; title: string }): Promise<EnsureOutcome>;
  placeItems(input: {
    mediaIds: MediaId[];
    placement: Placement;
  }): Promise<LecternResult>;
  removeItem(itemId: LecternItemId): Promise<LecternResult>;
  /** Optimistic: the new order shows at once and is refetched if the server refuses it. */
  setOrder(itemIds: LecternItemId[]): Promise<LecternResult>;
  ensureMediaFinished(mediaId: MediaId): Promise<ConsumptionResult>;
  /** Finish, leave the Lectern, and name the next readable row. */
  done(mediaId: MediaId): Promise<ConsumptionResult>;
  setUnread(mediaId: MediaId): Promise<ConsumptionResult>;
  resetProgress(mediaId: MediaId): Promise<ConsumptionResult>;
  undoFinish(input: {
    mediaId: MediaId;
    finishId: FinishId;
    restore: UndoRestore | null;
  }): Promise<ConsumptionResult>;
  settleNaturalEnd(
    input: NaturalEnd & { clientMutationId: string },
  ): Promise<ConsumptionResult>;
  /** Refetch now, after any queued work. */
  revalidate(): void;
  getCanonicalSnapshot(): LecternSnapshot | undefined;
  onCanonicalInstall(listener: CanonicalInstallListener): () => void;
  registerProgressFence(hook: {
    prepare(mediaIds: readonly MediaId[]): Promise<void>;
    reconcile(mediaIds: readonly MediaId[]): Promise<void>;
  }): () => void;
}

const LecternContext = createContext<LecternCapability | null>(null);

async function getLectern(cache?: RequestCache): Promise<LecternSnapshot> {
  const body = await apiFetch<ApiJson<"/lectern", "get">>("/api/lectern", {
    cache,
  });
  return lecternSnapshotFromWire(body.data);
}

async function postLectern(
  body: Schema<"EnsureItemCommand"> | Schema<"PlaceItemsCommand"> |
    Schema<"RemoveItemCommand"> | Schema<"SetOrderCommand">,
  signal?: AbortSignal,
): Promise<LecternResult> {
  const { data } = await apiFetch<ApiJson<"/lectern/commands", "post">>(
    "/api/lectern/commands",
    {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    },
  );
  let outcome: LecternResult["outcome"];
  switch (data.outcome.kind) {
    case "Ensured":
    case "Ordered":
      outcome = data.outcome;
      break;
    case "Placed":
      outcome = { kind: "Placed", itemIds: data.outcome.item_ids.map(parseLecternItemId) };
      break;
    case "Removed":
      outcome = { kind: "Removed", itemId: parseLecternItemId(data.outcome.item_id) };
      break;
    default:
      return assertNever(data.outcome, "Unsupported Lectern outcome");
  }
  return { outcome, lectern: lecternSnapshotFromWire(data.lectern) };
}

async function postConsumption(body: object): Promise<ConsumptionResult> {
  const response = await apiFetch<ApiJson<"/consumption/commands", "post">>(
    "/api/consumption/commands",
    {
      method: "POST",
      body: JSON.stringify({ client_mutation_id: createRandomId(), ...body }),
    },
  );
  return consumptionResultFromWire(response.data);
}

export function LecternProvider({ children }: { children: ReactNode }) {
  const [resource, setResource] = useState<LecternRead>({
    status: "loading",
  });
  const [inFlight, setInFlight] = useState(0);
  const [ensureRequests, setEnsureRequests] = useState<ReadonlyMap<MediaId, EnsureRequest>>(new Map());
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const pendingEnsures = useRef(new Map<MediaId, PendingEnsure>());
  const active = useRef(true);
  const feedback = useFeedback();
  const workspace = useWorkspaceStore();
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const snapshot = useRef<LecternSnapshot | undefined>(undefined);
  const installedAt = useRef(0);
  const listeners = useRef(new Set<CanonicalInstallListener>());
  const fenceHooks = useRef(new Set<Parameters<LecternCapability["registerProgressFence"]>[0]>());

  const install = useCallback((next: LecternSnapshot) => {
    snapshot.current = next;
    installedAt.current = Date.now();
    setResource({ status: "ready", data: next });
  }, []);

  const serial = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const result = chain.current.then(task);
    chain.current = result.catch(() => undefined);
    return result;
  }, []);

  const publishEnsureRequests = useCallback(() => {
    setEnsureRequests(new Map([...pendingEnsures.current].map(([id, pending]) => [id, pending.state])));
  }, []);

  const showEnsureRecovery = useCallback((pending: PendingEnsure, checking: boolean) => {
    feedback.publish({
      kind: "Persistent",
      key: `lectern-add:${pending.command.client_mutation_id}`,
      announcement: "Polite",
      content: checking
        ? { tone: "Neutral", title: "checking the add…", message: pending.title }
        : { tone: "Warning", title: `couldn’t confirm adding ${pending.title}`,
          message: "it may already be on lectern." },
      actions: [{ label: "check add", onClick: pending.check, busy: checking }],
      returnFocus: () => {
        if (!active.current) return null;
        const paneId = workspaceRef.current.state.active_primary_pane_id;
        const item = snapshot.current?.items.find((item) => item.mediaSummary.media_id === pending.mediaId);
        return findPaneCollectionRowFocusTarget(paneId, `media:${pending.mediaId}`) ??
          (item ? findPaneCollectionRowFocusTarget(paneId, item.itemId) : null) ??
          findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
      },
    });
  }, [feedback]);

  const attemptEnsure = useCallback((pending: PendingEnsure): Promise<EnsureOutcome> => {
    if (!active.current || pendingEnsures.current.get(pending.mediaId) !== pending)
      return Promise.resolve("Unconfirmed");
    if (pending.attempt !== null) return pending.attempt;
    const checking = pending.state.kind === "Unconfirmed";
    pending.state = { kind: checking ? "Checking" : "Sending" };
    publishEnsureRequests();
    if (checking) showEnsureRecovery(pending, true);
    setInFlight((count) => count + 1);
    pending.attempt = serial<EnsureOutcome>(async () => {
      if (!active.current || pendingEnsures.current.get(pending.mediaId) !== pending)
        return "Unconfirmed";
      const signal = AbortSignal.timeout(30_000);
      let result: LecternResult;
      try {
        result = await postLectern(pending.command, signal);
        if (result.outcome.kind !== "Ensured")
          // justify-defect: this fixed command can only be acknowledged by an Ensured receipt.
          throw new ApiError(200, "E_INVALID_RESPONSE", "EnsureItem returned an unexpected outcome");
      } catch (error) {
        if (!active.current || pendingEnsures.current.get(pending.mediaId) !== pending)
          return "Unconfirmed";
        pending.state = { kind: "Unconfirmed", check: pending.check };
        const refusal = isApiError(error) && (
          error.code === "E_NOT_FOUND" || error.code === "E_MEDIA_DELETING" || error.code === "E_LIMIT"
        );
        if (refusal && !checking) {
          pendingEnsures.current.delete(pending.mediaId);
          publishEnsureRequests();
          throw error;
        }
        publishEnsureRequests();
        if (isSameSystemApiDefect(error)) throw error;
        if (refusal || signal.aborted ||
          (isApiError(error) && (error.code === "E_NETWORK" || error.code === "E_UPSTREAM" ||
            error.code === "E_UPSTREAM_TIMEOUT"))) {
          showEnsureRecovery(pending, false);
          return "Unconfirmed";
        }
        if (handleUnauthenticatedApiError(error) || !isApiError(error))
          throw error;
        // justify-defect: this fixed command has no other modeled refusal; invalid shape or replay identity is a bug.
        throw new Error("Unexpected EnsureItem refusal", { cause: error });
      }
      if (!active.current || pendingEnsures.current.get(pending.mediaId) !== pending)
        return "Unconfirmed";
      // Retire the receipt before local work: observer failure cannot replay this acknowledged intent.
      pendingEnsures.current.delete(pending.mediaId);
      const reportDefect = (error: unknown) => {
        if (active.current) setDefect((current) => current ?? { error });
      };
      const afterReceipt = (work: () => void | Promise<void>) => {
        try {
          void Promise.resolve(work()).catch(reportDefect);
        } catch (error) {
          reportDefect(error);
        }
      };
      afterReceipt(() => install(result.lectern));
      const event: CanonicalInstallEvent = { kind: "ensureAcknowledged", mediaId: pending.mediaId };
      for (const listener of listeners.current) afterReceipt(() => listener(event));
      afterReceipt(() => publishChange("Consumption"));
      afterReceipt(publishEnsureRequests);
      afterReceipt(() => feedback.resolve(`lectern-add:${pending.command.client_mutation_id}`));
      afterReceipt(() => feedback.publish({
        kind: "Hud",
        content: { tone: "Success", title: "add confirmed.", message: pending.title },
      }));
      return "Acknowledged";
    }).finally(() => {
      pending.attempt = null;
      if (active.current) setInFlight((count) => count - 1);
    });
    return pending.attempt;
  }, [feedback, install, publishEnsureRequests, serial, showEnsureRecovery]);

  const ensureItem = useCallback(({ mediaId, title }: { mediaId: MediaId; title: string }) => {
    if (!active.current) return Promise.resolve<EnsureOutcome>("Unconfirmed");
    let pending = pendingEnsures.current.get(mediaId);
    if (!pending) {
      const command: Schema<"EnsureItemCommand"> = {
        kind: "EnsureItem", media_id: mediaId,
        client_mutation_id: createRandomId(),
      };
      const created: PendingEnsure = {
        mediaId, title, command, state: { kind: "Sending" }, attempt: null,
        check: () => {
          if (!active.current || pendingEnsures.current.get(mediaId) !== created) return;
          void attemptEnsure(created).catch((error) => {
            if (!active.current || handleUnauthenticatedApiError(error)) return;
            setDefect({ error });
          });
        },
      };
      pending = created;
      pendingEnsures.current.set(mediaId, pending);
    }
    return attemptEnsure(pending);
  }, [attemptEnsure]);

  useEffect(() => {
    active.current = true;
    const pending = pendingEnsures.current;
    return () => {
      active.current = false;
      for (const request of pending.values()) feedback.resolve(`lectern-add:${request.command.client_mutation_id}`);
      pending.clear();
    };
  }, [feedback]);

  const refetch = useCallback(
    (cache?: RequestCache) =>
      serial(async () => {
        try {
          install(await getLectern(cache));
        } catch (error) {
          // justify-ignore-error: a background refresh keeps the last good snapshot.
          handleUnauthenticatedApiError(error);
        }
      }),
    [install, serial],
  );

  const run = useCallback(
    <T extends LecternResult | ConsumptionResult>(
      send: () => Promise<T>,
      fenceIds: readonly MediaId[] = [],
      unreadIds: readonly MediaId[] = [],
    ): Promise<T> => {
      setInFlight((count) => count + 1);
      return serial(async () => {
        const hooks = fenceIds.length ? [...fenceHooks.current] : [];
        let acknowledged = false;
        try {
          const preparations = await Promise.allSettled(hooks.map((hook) => hook.prepare(fenceIds)));
          const refused = preparations.find((result) => result.status === "rejected");
          if (refused?.status === "rejected") throw refused.reason;
          const result = await send();
          acknowledged = true;
          install(result.lectern);
          publishChange("Consumption");
          const event: CanonicalInstallEvent = { kind: "snapshot", snapshot: result.lectern, unreadMediaIds: unreadIds };
          await Promise.all([...listeners.current].map((listener) => listener(event)));
          if ("progressState" in result && result.progressState !== null) {
            const state = result.progressState;
            await Promise.all([...listeners.current].map((listener) => listener({ kind: "progressState", state })));
          } else {
            await Promise.all(hooks.map((hook) => hook.reconcile(fenceIds)));
          }
          return result;
        } catch (error) {
          if (!acknowledged) await Promise.allSettled(hooks.map((hook) => hook.reconcile(fenceIds)));
          if (!isApiError(error) || error.status !== 401) {
            try {
              install(await getLectern("no-store"));
            } catch {
              // justify-ignore-error: the command's own error is the one the caller handles.
            }
          }
          throw error;
        }
      }).finally(() => setInFlight((count) => count - 1));
    },
    [install, serial],
  );

  const consumption = useCallback(
    (body: object, fenceIds: readonly MediaId[] = [], unreadIds: readonly MediaId[] = []) =>
      run(() => postConsumption(body), fenceIds, unreadIds),
    [run],
  );

  useEffect(() => {
    let mounted = true;
    const load = () => {
      setResource({ status: "loading" });
      void serial(async () => {
        try {
          const loaded = await getLectern();
          if (mounted) install(loaded);
        } catch (error) {
          if (handleUnauthenticatedApiError(error) || !mounted) return;
          setResource({ status: "error", error, retry: load });
        }
      });
    };
    load();
    const maybeRefetch = () => {
      if (
        document.visibilityState !== "visible" ||
        snapshot.current === undefined
      )
        return;
      if (Date.now() - installedAt.current >= REVALIDATE_MIN_INTERVAL_MS)
        void refetch();
    };
    window.addEventListener("focus", maybeRefetch);
    window.addEventListener("online", maybeRefetch);
    document.addEventListener("visibilitychange", maybeRefetch);
    return () => {
      mounted = false;
      window.removeEventListener("focus", maybeRefetch);
      window.removeEventListener("online", maybeRefetch);
      document.removeEventListener("visibilitychange", maybeRefetch);
    };
  }, [install, refetch, serial]);

  const metadataRevision = useChangeStamp("Metadata");
  const seenMetadataRevision = useRef(metadataRevision);
  useEffect(() => {
    if (seenMetadataRevision.current === metadataRevision) return;
    seenMetadataRevision.current = metadataRevision;
    void refetch("no-store");
  }, [metadataRevision, refetch]);

  const value = useMemo<LecternCapability>(
    () => ({
      resource,
      busy: inFlight > 0,
      ensureRequests,
      ensureItem,
      placeItems: ({ mediaIds, placement }) =>
        run(() =>
          postLectern({
            kind: "PlaceItems",
            media_ids: mediaIds,
            placement:
              placement.kind === "After"
                ? { kind: "After", item_id: placement.itemId }
                : placement,
            client_mutation_id: createRandomId(),
          }),
        ),
      removeItem: (itemId) =>
        run(() => postLectern({ kind: "RemoveItem", item_id: itemId, client_mutation_id: createRandomId() })),
      setOrder: (itemIds) => {
        const current = snapshot.current;
        if (current !== undefined) {
          const byId = new Map(
            current.items.map((item) => [item.itemId, item]),
          );
          const items = itemIds.flatMap((itemId) => byId.get(itemId) ?? []);
          setResource({ status: "ready", data: { ...current, items } });
        }
        return run(() => postLectern({ kind: "SetOrder", item_ids: itemIds, client_mutation_id: createRandomId() }));
      },
      ensureMediaFinished: (mediaId) =>
        consumption({ kind: "EnsureMediaFinished", media_id: mediaId }),
      done: (mediaId) => consumption({ kind: "Done", media_id: mediaId }),
      setUnread: (mediaId) => consumption({ kind: "SetUnread", media_id: mediaId }, [mediaId], [mediaId]),
      resetProgress: (mediaId) => consumption({ kind: "ResetProgress", media_id: mediaId }, [mediaId]),
      undoFinish: ({ mediaId, finishId, restore }) =>
        consumption(
          {
            kind: "UndoFinish",
            media_id: mediaId,
            finish_id: finishId,
            restore:
              restore === null
                ? null
                : { item_id: restore.itemId, added_at: restore.addedAt, after: restore.after },
          },
          [mediaId],
        ),
      settleNaturalEnd: (input) =>
        consumption({
          kind: "SettleNaturalEnd",
          client_mutation_id: input.clientMutationId,
          media_id: input.mediaId,
          terminal_listening: input.terminalListening,
          expected_consumption_override_revision: input.expectedConsumptionOverrideRevision,
        }),
      revalidate: () => void refetch("no-store"),
      getCanonicalSnapshot: () => snapshot.current,
      onCanonicalInstall: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      registerProgressFence: (hook) => {
        fenceHooks.current.add(hook);
        return () => fenceHooks.current.delete(hook);
      },
    }),
    [consumption, ensureItem, ensureRequests, inFlight, refetch, resource, run],
  );

  if (defect) throw defect.error;
  return (
    <LecternContext.Provider value={value}>{children}</LecternContext.Provider>
  );
}

export function useLectern(): LecternCapability {
  const value = useContext(LecternContext);
  if (value === null)
    throw new Error("useLectern must be used within a LecternProvider.");
  return value;
}
