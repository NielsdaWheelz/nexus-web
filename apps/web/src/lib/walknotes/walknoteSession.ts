"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createElement } from "react";
import { apiFetch } from "@/lib/api/client";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { resolveActiveTranscriptFragment } from "@/lib/media/transcriptView";
import { createHighlight, saveHighlightNote } from "@/lib/highlights/api";
import { pmDocFromText } from "@/lib/walknotes/pmDoc";
import type { Fragment } from "@/lib/media/transcriptView";

export const E_WALKNOTE_NO_FRAGMENT = "E_WALKNOTE_NO_FRAGMENT";

export type WaypointVoiceStatus = "idle" | "recording" | "transcribing" | "done" | "failed";

export interface WalknoteWaypoint {
  id: string;
  media_id: string;
  position_ms: number;
  recorded_at: string;
  voice_text: string | null;
  voice_status: WaypointVoiceStatus;
}

export const SESSION_STORAGE_KEY = "nexus.walknotes.session";

export function loadFromSessionStorage(): WalknoteWaypoint[] {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as WalknoteWaypoint[];
  } catch {
    return [];
  }
}

export function saveToSessionStorage(waypoints: WalknoteWaypoint[]): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(waypoints));
  } catch {
    // sessionStorage may be unavailable (e.g. private mode)
  }
}

export interface WalknoteSessionContextValue {
  waypoints: WalknoteWaypoint[];
  addWaypoint: (media_id: string, position_ms: number) => string;
  updateWaypointVoice: (id: string, status: WaypointVoiceStatus, text?: string) => void;
  removeWaypoint: (id: string) => void;
  materialize: (keptIds: string[]) => Promise<{ created: number; errors: string[] }>;
  clearSession: () => void;
}

const WalknoteSessionContext = createContext<WalknoteSessionContextValue | null>(null);

export function WalknoteSessionProvider({ children }: { children: ReactNode }) {
  const [waypoints, setWaypoints] = useState<WalknoteWaypoint[]>(() =>
    loadFromSessionStorage()
  );
  // Cache fetched fragments per media_id across materialize calls
  const fragmentsCacheRef = useRef<Map<string, Fragment[]>>(new Map());
  const handleUnauthenticated = useUnauthenticatedApiHandler();

  const updateAndPersist = useCallback((next: WalknoteWaypoint[]) => {
    setWaypoints(next);
    saveToSessionStorage(next);
  }, []);

  const addWaypoint = useCallback(
    (media_id: string, position_ms: number): string => {
      const id = crypto.randomUUID();
      setWaypoints((prev) => {
        const next: WalknoteWaypoint[] = [
          ...prev,
          {
            id,
            media_id,
            position_ms,
            recorded_at: new Date().toISOString(),
            voice_text: null,
            voice_status: "idle",
          },
        ];
        saveToSessionStorage(next);
        return next;
      });
      return id;
    },
    []
  );

  const updateWaypointVoice = useCallback(
    (id: string, status: WaypointVoiceStatus, text?: string) => {
      setWaypoints((prev) => {
        const next = prev.map((w) =>
          w.id === id
            ? {
                ...w,
                voice_status: status,
                voice_text: text !== undefined ? text : w.voice_text,
              }
            : w
        );
        saveToSessionStorage(next);
        return next;
      });
    },
    []
  );

  const removeWaypoint = useCallback(
    (id: string) => {
      setWaypoints((prev) => {
        const next = prev.filter((w) => w.id !== id);
        saveToSessionStorage(next);
        return next;
      });
    },
    []
  );

  const materialize = useCallback(
    async (keptIds: string[]): Promise<{ created: number; errors: string[] }> => {
      const toMaterialize = waypoints.filter((w) => keptIds.includes(w.id));
      const errors: string[] = [];
      let created = 0;

      for (const waypoint of toMaterialize) {
        try {
          // Fetch and cache fragments for this media_id
          let fragments = fragmentsCacheRef.current.get(waypoint.media_id);
          if (!fragments) {
            const resp = await apiFetch<{ data: Fragment[] }>(
              `/api/media/${waypoint.media_id}/fragments`
            );
            fragments = resp.data;
            fragmentsCacheRef.current.set(waypoint.media_id, fragments);
          }

          const fragment = resolveActiveTranscriptFragment(fragments, {
            requestedStartMs: waypoint.position_ms,
          });

          if (!fragment) {
            errors.push(E_WALKNOTE_NO_FRAGMENT);
            continue;
          }

          const highlight = await createHighlight(
            fragment.id,
            0,
            fragment.canonical_text.length,
            "yellow"
          );

          if (waypoint.voice_text !== null) {
            await saveHighlightNote(
              highlight.id,
              null,
              crypto.randomUUID(),
              pmDocFromText(waypoint.voice_text),
              crypto.randomUUID()
            );
          }

          created++;
        } catch (err) {
          if (handleUnauthenticated(err)) throw err;
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      // Clear session after materialize
      fragmentsCacheRef.current.clear();
      updateAndPersist([]);

      return { created, errors };
    },
    [waypoints, updateAndPersist, handleUnauthenticated]
  );

  const clearSession = useCallback(() => {
    updateAndPersist([]);
  }, [updateAndPersist]);

  const value = useMemo<WalknoteSessionContextValue>(
    () => ({
      waypoints,
      addWaypoint,
      updateWaypointVoice,
      removeWaypoint,
      materialize,
      clearSession,
    }),
    [waypoints, addWaypoint, updateWaypointVoice, removeWaypoint, materialize, clearSession]
  );

  return createElement(WalknoteSessionContext.Provider, { value }, children);
}

const NO_OP_SESSION: WalknoteSessionContextValue = {
  waypoints: [],
  addWaypoint: () => "",
  updateWaypointVoice: () => {},
  removeWaypoint: () => {},
  materialize: () => Promise.resolve({ created: 0, errors: [] }),
  clearSession: () => {},
};

export function useWalknoteSession(): WalknoteSessionContextValue {
  return useContext(WalknoteSessionContext) ?? NO_OP_SESSION;
}
