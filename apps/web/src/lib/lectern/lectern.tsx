"use client";

/**
 * The viewer's Lectern: one shared read for the shell (the pane, the reader's next prompt, the
 * player's next row, the action menus), its writes and the adds still awaiting an answer. Writes
 * are absolute and idempotent (`PUT`/`DELETE /lectern/items/{media_id}`); each publishes
 * `Lectern` and the read follows. Another device's change arrives when the page returns to the
 * screen (at most once a minute).
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
import { useFeedback } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import {
  usePaneFreeServerValue,
  useThrowLater,
  type ServerValue,
} from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import {
  findPaneChromeFocusTarget,
  findPaneCollectionRowFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { useWorkspaceStore } from "@/lib/workspace/store";

export type Lectern = Schema<"LecternOut">;
export type LecternItem = Lectern["items"][number];
export type Placement = NonNullable<Schema<"PlaceIn">["placement"]>;
/** An add without an answer yet: sent, being checked, or unconfirmed until checked. */
export type LecternAdd =
  | { kind: "Sending" | "Checking" }
  | { kind: "Unconfirmed"; check(): void };
type AddAnswer = "Acknowledged" | "Unconfirmed";
interface PendingAdd {
  readonly mediaId: string;
  readonly title: string;
  readonly key: string;
  readonly check: () => void;
  state: LecternAdd;
  attempt: Promise<AddAnswer> | null;
}

const LecternContext = createContext<{
  read: ServerValue<Lectern>;
  adds: ReadonlyMap<string, LecternAdd>;
  add(input: { mediaId: string; title: string }): Promise<AddAnswer>;
  onAcknowledged(listener: (mediaId: string) => void): () => void;
} | null>(null);

export function LecternProvider({ children }: { children: ReactNode }) {
  const changes = useChangeStamp("Lectern", "Metadata");
  const foreground = useRefreshStamp(true, 60_000);
  const read = usePaneFreeServerValue({
    key: "/lectern",
    stale: `${changes}:${foreground}`,
    load: async (signal) =>
      (await apiFetch<ApiJson<"/lectern", "get">>("/api/lectern", { signal }))
        .data,
  });

  // An add keeps its request until answered: a lost answer leaves "check add", which sends the
  // same idempotent PUT again; a second add of that media joins the first.
  const feedback = useFeedback();
  const workspace = useWorkspaceStore();
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const fail = useThrowLater();
  const pending = useRef(new Map<string, PendingAdd>());
  const acknowledgements = useRef(new Set<(mediaId: string) => void>());
  const onAcknowledged = useCallback((listener: (mediaId: string) => void) => {
    acknowledgements.current.add(listener);
    return () => { acknowledgements.current.delete(listener); };
  }, []);
  const live = useRef(true);
  const [adds, setAdds] = useState<ReadonlyMap<string, LecternAdd>>(new Map());
  const publishAdds = useCallback(() => {
    setAdds(new Map([...pending.current].map(([id, add]) => [id, add.state])));
  }, []);

  const showRecovery = useCallback((add: PendingAdd, checking: boolean) => {
    feedback.publish({
      kind: "Persistent",
      key: add.key,
      announcement: "Polite",
      content: checking
        ? { tone: "Neutral", title: "checking the add…", message: add.title }
        : { tone: "Warning", title: `couldn’t confirm adding ${add.title}`,
          message: "it may already be on lectern." },
      actions: [{ label: "check add", onClick: add.check, busy: checking }],
      returnFocus: () => {
        if (!live.current) return null;
        const paneId = workspaceRef.current.state.active_primary_pane_id;
        return findPaneCollectionRowFocusTarget(paneId, `media:${add.mediaId}`) ??
          findPaneCollectionRowFocusTarget(paneId, add.mediaId) ??
          findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
      },
    });
  }, [feedback]);

  const attempt = useCallback((add: PendingAdd): Promise<AddAnswer> => {
    // A superseded or unmounted add settles nothing.
    const current = () => live.current && pending.current.get(add.mediaId) === add;
    if (!current()) return Promise.resolve("Unconfirmed");
    if (add.attempt !== null) return add.attempt;
    const checking = add.state.kind === "Unconfirmed";
    add.state = { kind: checking ? "Checking" : "Sending" };
    publishAdds();
    if (checking) showRecovery(add, true);
    add.attempt = (async (): Promise<AddAnswer> => {
      const signal = AbortSignal.timeout(30_000);
      try {
        await apiFetch<void>(`/api/lectern/items/${add.mediaId}`, {
          method: "PUT",
          body: JSON.stringify({ placement: null }),
          signal,
        });
      } catch (error) {
        if (!current()) return "Unconfirmed";
        add.state = { kind: "Unconfirmed", check: add.check };
        const refusal = isApiError(error) && (error.code === "E_NOT_FOUND" ||
          error.code === "E_MEDIA_DELETING" || error.code === "E_LIMIT");
        if (refusal && !checking) {
          pending.current.delete(add.mediaId);
          publishAdds();
          throw error;
        }
        publishAdds();
        if (isSameSystemApiDefect(error)) throw error;
        if (refusal || signal.aborted || (isApiError(error) && (error.code === "E_NETWORK" ||
          error.code === "E_UPSTREAM" || error.code === "E_UPSTREAM_TIMEOUT"))) {
          showRecovery(add, false);
          return "Unconfirmed";
        }
        if (handleUnauthenticatedApiError(error) || !isApiError(error)) throw error;
        // justify-defect: an idempotent add has no other modeled refusal.
        throw new Error("Unexpected Lectern add refusal", { cause: error });
      }
      if (!current()) return "Unconfirmed";
      pending.current.delete(add.mediaId);
      publishAdds();
      publishChange("Lectern");
      for (const listener of acknowledgements.current) listener(add.mediaId);
      feedback.resolve(add.key);
      feedback.publish({
        kind: "Hud",
        content: { tone: "Success", title: "add confirmed.", message: add.title },
      });
      return "Acknowledged";
    })().finally(() => {
      add.attempt = null;
    });
    return add.attempt;
  }, [feedback, publishAdds, showRecovery]);

  const add = useCallback(({ mediaId, title }: { mediaId: string; title: string }) => {
    if (!live.current) return Promise.resolve<AddAnswer>("Unconfirmed");
    let entry = pending.current.get(mediaId);
    if (!entry) {
      const created: PendingAdd = {
        mediaId, title, key: `lectern-add:${mediaId}`, state: { kind: "Sending" }, attempt: null,
        check: () => {
          void attempt(created).catch((error) => {
            if (live.current && !handleUnauthenticatedApiError(error)) fail({ error });
          });
        },
      };
      entry = created;
      pending.current.set(mediaId, entry);
    }
    return attempt(entry);
  }, [attempt, fail]);

  useEffect(() => {
    live.current = true;
    const adds = pending.current;
    return () => {
      live.current = false;
      for (const add of adds.values()) feedback.resolve(add.key);
      adds.clear();
    };
  }, [feedback]);

  const value = useMemo(() => ({ read, adds, add, onAcknowledged }), [read, adds, add, onAcknowledged]);
  return (
    <LecternContext.Provider value={value}>
      {children}
    </LecternContext.Provider>
  );
}

function useLecternContext() {
  const value = useContext(LecternContext);
  if (value === null)
    throw new Error("useLectern must be used within a LecternProvider.");
  return value;
}

export function useLectern(): ServerValue<Lectern> {
  return useLecternContext().read;
}

/** The adds awaiting an answer, by media id, and the add itself (a present row stays put). */
export function useLecternAdds(): {
  adds: ReadonlyMap<string, LecternAdd>;
  add(input: { mediaId: string; title: string }): Promise<AddAnswer>;
  onAcknowledged(listener: (mediaId: string) => void): () => void;
} {
  const { adds, add, onAcknowledged } = useLecternContext();
  return { adds, add, onAcknowledged };
}

/** The loaded rows, empty until the first read lands. */
export function lecternItems(
  lectern: ServerValue<Lectern>,
): readonly LecternItem[] {
  return lectern.status === "ready" ? lectern.data.items : [];
}

/** Whether the whole membership, hidden rows included, is at the cap (the server's count). */
export function lecternFull(lectern: ServerValue<Lectern>): boolean {
  return lectern.status === "ready" && lectern.data.at_capacity;
}

/** The one successor rule: the first row of `kind` after `mediaId`'s row, from the head when
 * that media has no row. */
export function lecternNext(
  items: readonly LecternItem[],
  mediaId: string | null,
  kind: LecternItem["activation"]["kind"],
): LecternItem | null {
  const at = items.findIndex((item) => item.media_summary.media_id === mediaId);
  return (
    items.slice(at + 1).find((item) => item.activation.kind === kind) ?? null
  );
}

export async function placeOnLectern(
  mediaId: string,
  placement: Placement,
): Promise<void> {
  await apiFetch<void>(`/api/lectern/items/${mediaId}`, {
    method: "PUT",
    body: JSON.stringify({ placement }),
  });
  publishChange("Lectern");
}

export async function removeFromLectern(mediaId: string): Promise<void> {
  await apiFetch<void>(`/api/lectern/items/${mediaId}`, { method: "DELETE" });
  publishChange("Lectern");
}
