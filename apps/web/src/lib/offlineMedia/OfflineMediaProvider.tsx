"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import DownloadsOverlay from "@/components/offlineMedia/DownloadsOverlay";
import { apiFetch } from "@/lib/api/client";
import { absent, type Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  OfflineMediaClientStore,
  type OfflineMediaInventoryItem,
} from "./clientStore";
import { projectOfflineMediaAnnouncementMilestone } from "./announcements";
import {
  OfflineMediaRejectedError,
  OfflineMediaControllerRuntime,
  offlineMediaRejectionMessage,
  type OfflineDownloadSpecReader,
  type OfflineMediaController,
} from "./controller";
import {
  decodeOfflineDownloadSpecEnvelope,
  type LocalAvailability,
} from "./contract";
import {
  createWebKitOfflineMediaTransport,
  type OfflineMediaTransport,
} from "./transport";

export type OfflineMediaCapability =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Connecting" }
  | {
      readonly kind: "Ready";
      readonly controller: OfflineMediaController;
      readonly store: OfflineMediaClientStore;
    };

const UNAVAILABLE: OfflineMediaCapability = { kind: "Unavailable" };
const CONNECTING: OfflineMediaCapability = { kind: "Connecting" };
const ABSENT_AVAILABILITY: Presence<LocalAvailability> = absent();
const EMPTY_INVENTORY: readonly OfflineMediaInventoryItem[] = [];

const OfflineMediaContext =
  createContext<OfflineMediaCapability>(UNAVAILABLE);

function OfflineMediaAnnouncements({
  store,
}: {
  readonly store: OfflineMediaClientStore;
}) {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeInventory(listener),
    [store],
  );
  const inventory = useSyncExternalStore(
    subscribe,
    store.getInventory,
    () => EMPTY_INVENTORY,
  );
  const milestonesRef = useRef<ReadonlyMap<string, string>>(new Map());
  const primedRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const nextMilestones = new Map<string, string>();
    let nextAnnouncement: string | null = null;
    for (const item of inventory) {
      const milestone = projectOfflineMediaAnnouncementMilestone(item);
      nextMilestones.set(item.mediaId, milestone.key);
      if (
        primedRef.current &&
        milestonesRef.current.get(item.mediaId) !== milestone.key
      ) {
        nextAnnouncement = milestone.message;
      }
    }
    milestonesRef.current = nextMilestones;
    if (!primedRef.current) {
      primedRef.current = true;
      return;
    }
    if (nextAnnouncement !== null) setAnnouncement(nextAnnouncement);
  }, [inventory]);

  return (
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </span>
  );
}

async function readOfflineDownloadSpec(
  mediaId: string,
  signal: AbortSignal,
) {
  const raw = await apiFetch<unknown>(
    `/api/media/${mediaId}/offline-download-spec`,
    { cache: "no-store", signal },
  );
  return decodeOfflineDownloadSpecEnvelope(raw);
}

export function OfflineMediaProvider({
  accountId,
  children,
  transport,
  downloadSpecReader = readOfflineDownloadSpec,
  ownedOrigin,
}: {
  readonly accountId: string;
  readonly children: ReactNode;
  readonly transport?: OfflineMediaTransport | null;
  readonly downloadSpecReader?: OfflineDownloadSpecReader;
  readonly ownedOrigin?: string;
}) {
  const feedback = useFeedback();
  const [session, setSession] = useState<{
    readonly accountId: string;
    readonly capability: OfflineMediaCapability;
  }>({ accountId, capability: UNAVAILABLE });
  const capability =
    session.accountId === accountId ? session.capability : CONNECTING;
  const [asyncDefect, setAsyncDefect] = useState<Error | null>(null);
  const [downloadsOpen, setDownloadsOpen] = useState(false);

  useEffect(() => {
    const sessionTransport =
      transport === undefined
        ? createWebKitOfflineMediaTransport()
        : transport;
    if (sessionTransport === null) {
      setSession({ accountId, capability: UNAVAILABLE });
      setDownloadsOpen(false);
      return;
    }

    let current = true;
    let connected = false;
    const store = new OfflineMediaClientStore();
    const controller = new OfflineMediaControllerRuntime(
      accountId,
      store,
      sessionTransport,
      downloadSpecReader,
      ownedOrigin ?? window.location.origin,
      (message) =>
        feedback.publish({
          kind: "Hud",
          key: "offline-media-command",
          content: {
            tone: "Warning",
            title: "Offline download wasn’t changed",
            message,
          },
        }),
      (error) => {
        if (!current) return;
        setSession({ accountId, capability: UNAVAILABLE });
        setAsyncDefect(error);
      },
      handleUnauthenticatedApiError,
      () => setDownloadsOpen(true),
    );
    setSession({ accountId, capability: CONNECTING });
    void controller
      .connect()
      .then(() => {
        if (!current) return;
        connected = true;
        feedback.resolve("offline-media-connect");
        setSession({
          accountId,
          capability: { kind: "Ready", controller, store },
        });
      })
      .catch((error) => {
        if (!current || isAbortError(error)) return;
        controller.dispose();
        setSession({ accountId, capability: UNAVAILABLE });
        if (!(error instanceof OfflineMediaRejectedError)) {
          setAsyncDefect(
            error instanceof Error
              ? error
              : new Error("Offline media connection failed"),
          );
          return;
        }
        feedback.publish({
          kind: "Hud",
          key: "offline-media-connect",
          content: {
            tone: "Warning",
            title: "Offline downloads are unavailable",
            message: offlineMediaRejectionMessage(error.code),
          },
        });
      });

    const refreshOnVisibility = () => {
      if (!connected || document.visibilityState !== "visible") return;
      void controller.refreshSnapshot().catch((error) => {
        if (!current) return;
        setAsyncDefect(
          error instanceof Error
            ? error
            : new Error("Offline media snapshot failed"),
        );
      });
    };
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      current = false;
      setDownloadsOpen(false);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
      controller.dispose();
    };
  }, [accountId, downloadSpecReader, feedback, ownedOrigin, transport]);

  if (asyncDefect !== null) throw asyncDefect;

  return (
    <OfflineMediaContext.Provider value={capability}>
      {children}
      {capability.kind === "Ready" ? (
        <>
          <OfflineMediaAnnouncements store={capability.store} />
          <DownloadsOverlay
            open={downloadsOpen}
            onClose={() => setDownloadsOpen(false)}
            store={capability.store}
            controller={capability.controller}
          />
        </>
      ) : null}
    </OfflineMediaContext.Provider>
  );
}

export function useOfflineMediaCapability(): OfflineMediaCapability {
  return useContext(OfflineMediaContext);
}

export function useOfflineMediaItem(
  mediaId: string | null,
  title?: string,
): {
  readonly capability: OfflineMediaCapability;
  readonly availability: Presence<LocalAvailability>;
} {
  const capability = useOfflineMediaCapability();
  const store = capability.kind === "Ready" ? capability.store : null;

  useEffect(() => {
    if (store !== null && mediaId !== null && title !== undefined) {
      store.noteTitle(mediaId, title);
    }
  }, [mediaId, store, title]);

  const subscribe = useCallback(
    (listener: () => void) =>
      store !== null && mediaId !== null
        ? store.subscribeItem(mediaId, listener)
        : () => undefined,
    [mediaId, store],
  );
  const getSnapshot = useCallback(
    () =>
      store !== null && mediaId !== null
        ? store.getItem(mediaId)
        : ABSENT_AVAILABILITY,
    [mediaId, store],
  );
  const availability = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => ABSENT_AVAILABILITY,
  );
  return useMemo(
    () => ({ capability, availability }),
    [availability, capability],
  );
}
