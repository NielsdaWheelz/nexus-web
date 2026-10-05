"use client";

/**
 * The one owner of the viewer's Lectern snapshot and of every Lectern and consumption command.
 *
 * One promise chain serializes commands and refetches, so installs never interleave: a GET
 * queued before a command cannot overwrite that command's answer. Each call mints its own
 * `clientMutationId` (natural-end settles bring theirs, so retries replay). A failed command
 * refetches the truth and rethrows; the caller owns its error.
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
  decodeApiPayload,
  isApiError,
  ApiError,
} from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import type { AsyncResource } from "@/lib/api/useResource";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { publishConsumptionProjectionChange } from "@/lib/consumption/projectionRevision";
import { useMetadataCollectionRevision } from "@/lib/media/mediaMetadataOperations";
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

type ProgressListener = (event: {
  kind: "progressState";
  state: MediaProgressState;
}) => void;

export interface LecternCapability {
  readonly resource: AsyncResource<LecternSnapshot>;
  /** A command is in flight. */
  readonly busy: boolean;
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
    restore: Presence<UndoRestore>;
  }): Promise<ConsumptionResult>;
  settleNaturalEnd(
    input: NaturalEnd & { clientMutationId: string },
  ): Promise<ConsumptionResult>;
  /** Refetch now, after any queued work. */
  revalidate(): void;
  getCanonicalSnapshot(): LecternSnapshot | undefined;
  onCanonicalInstall(listener: ProgressListener): () => void;
  /** Awaited before ResetProgress runs, so readers drain their old writes first. */
  registerBeforeProgressReset(
    hook: (mediaId: MediaId) => Promise<void>,
  ): () => void;
}

const LecternContext = createContext<LecternCapability | null>(null);

async function getLectern(cache?: RequestCache): Promise<LecternSnapshot> {
  const body = await apiFetch<ApiJson<"/lectern", "get">>("/api/lectern", {
    cache,
  });
  return decodeApiPayload(
    body,
    (r) => lecternSnapshotFromWire(r.data),
    "GET /api/lectern",
  );
}

async function postLectern(body: object): Promise<LecternResult> {
  const response = await apiFetch<ApiJson<"/lectern/commands", "post">>(
    "/api/lectern/commands",
    {
      method: "POST",
      body: JSON.stringify({ clientMutationId: crypto.randomUUID(), ...body }),
    },
  );
  return decodeApiPayload(
    response,
    ({ data }): LecternResult => ({
      outcome:
        data.outcome.kind === "Placed"
          ? {
              kind: "Placed",
              itemIds: data.outcome.itemIds.map(parseLecternItemId),
            }
          : data.outcome.kind === "Removed"
            ? {
                kind: "Removed",
                itemId: parseLecternItemId(data.outcome.itemId),
              }
            : { kind: "Ordered" },
      lectern: lecternSnapshotFromWire(data.lectern),
    }),
    "POST /api/lectern/commands",
  );
}

async function postConsumption(body: object): Promise<ConsumptionResult> {
  const response = await apiFetch<ApiJson<"/consumption/commands", "post">>(
    "/api/consumption/commands",
    {
      method: "POST",
      body: JSON.stringify({ clientMutationId: crypto.randomUUID(), ...body }),
    },
  );
  return decodeApiPayload(
    response,
    ({ data }) => consumptionResultFromWire(data),
    "POST /api/consumption/commands",
  );
}

export function LecternProvider({ children }: { children: ReactNode }) {
  const [resource, setResource] = useState<AsyncResource<LecternSnapshot>>({
    status: "loading",
  });
  const [inFlight, setInFlight] = useState(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const snapshot = useRef<LecternSnapshot | undefined>(undefined);
  const installedAt = useRef(0);
  const listeners = useRef(new Set<ProgressListener>());
  const resetHooks = useRef(new Set<(mediaId: MediaId) => Promise<void>>());

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
    <T extends { lectern: LecternSnapshot }>(
      send: () => Promise<T>,
    ): Promise<T> => {
      setInFlight((count) => count + 1);
      return serial(async () => {
        try {
          const result = await send();
          install(result.lectern);
          publishConsumptionProjectionChange({ rowChanged: true });
          return result;
        } catch (error) {
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
    (body: object) =>
      run(() => postConsumption(body)).then((result) => {
        if (result.progressState.kind === "Present") {
          const state = result.progressState.value;
          for (const listener of listeners.current)
            listener({ kind: "progressState", state });
        }
        return result;
      }),
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
          const failure = isApiError(error)
            ? error
            : new ApiError(0, "E_NETWORK", "The Lectern could not be loaded");
          setResource({ status: "error", error: failure, retry: load });
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

  const metadataRevision = useMetadataCollectionRevision();
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
      placeItems: ({ mediaIds, placement }) =>
        run(() => postLectern({ kind: "PlaceItems", mediaIds, placement })),
      removeItem: (itemId) =>
        run(() => postLectern({ kind: "RemoveItem", itemId })),
      setOrder: (itemIds) => {
        const current = snapshot.current;
        if (current !== undefined) {
          const byId = new Map(
            current.items.map((item) => [item.itemId, item]),
          );
          const items = itemIds.flatMap((itemId) => byId.get(itemId) ?? []);
          setResource({ status: "ready", data: { items } });
        }
        return run(() => postLectern({ kind: "SetOrder", itemIds }));
      },
      ensureMediaFinished: (mediaId) =>
        consumption({ kind: "EnsureMediaFinished", mediaId }),
      done: (mediaId) => consumption({ kind: "Done", mediaId }),
      setUnread: (mediaId) => consumption({ kind: "SetUnread", mediaId }),
      resetProgress: async (mediaId) => {
        await Promise.all([...resetHooks.current].map((hook) => hook(mediaId)));
        return consumption({ kind: "ResetProgress", mediaId });
      },
      undoFinish: (input) => consumption({ kind: "UndoFinish", ...input }),
      settleNaturalEnd: (input) =>
        consumption({ kind: "SettleNaturalEnd", ...input }),
      revalidate: () => void refetch("no-store"),
      getCanonicalSnapshot: () => snapshot.current,
      onCanonicalInstall: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      registerBeforeProgressReset: (hook) => {
        resetHooks.current.add(hook);
        return () => resetHooks.current.delete(hook);
      },
    }),
    [consumption, inFlight, refetch, resource, run],
  );

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
