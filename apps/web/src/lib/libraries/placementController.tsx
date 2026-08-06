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
import LibraryPlacementOverlay from "@/components/libraries/LibraryPlacementOverlay";
import type { ResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import type { Presence } from "@/lib/api/presence";
import type { LibraryPlacementTarget } from "@/lib/libraries/libraryPlacement";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";

export interface LibraryPlacementOpenOptions {
  anchor: ReturnFocusTarget;
  returnFocusFallback: Presence<ReturnFocusTarget>;
  /** Runtime-owned exact `(ref, actionId)` mutation and reconciliation boundary. */
  mutation: ResourceActionMutationBoundary;
}

export interface LibraryPlacementSession {
  key: number;
  target: LibraryPlacementTarget;
  options: LibraryPlacementOpenOptions;
}

interface LibraryPlacementController {
  openLibraryPlacement: (
    target: LibraryPlacementTarget,
    options: LibraryPlacementOpenOptions,
  ) => void;
  closeLibraryPlacement: () => void;
}

const LibraryPlacementControllerContext =
  createContext<LibraryPlacementController | null>(null);

export function LibraryPlacementControllerProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [session, setSession] = useState<LibraryPlacementSession | null>(null);
  const sessionRef = useRef<LibraryPlacementSession | null>(null);
  const nextSessionKeyRef = useRef(0);
  const openLibraryPlacement = useCallback(
    (
      target: LibraryPlacementTarget,
      options: LibraryPlacementOpenOptions,
    ) => {
      // One visible editor owns its draft and mutation lifecycle. A second
      // menu invocation cannot silently replace that session.
      if (sessionRef.current !== null) return;
      nextSessionKeyRef.current += 1;
      const next = { key: nextSessionKeyRef.current, target, options };
      sessionRef.current = next;
      setSession(next);
    },
    [],
  );
  const closeLibraryPlacement = useCallback(() => {
    const current = sessionRef.current;
    if (current?.options.mutation.isActive()) return;
    sessionRef.current = null;
    setSession(null);
  }, []);
  const value = useMemo(
    () => ({ openLibraryPlacement, closeLibraryPlacement }),
    [closeLibraryPlacement, openLibraryPlacement],
  );

  return (
    <LibraryPlacementControllerContext.Provider value={value}>
      {children}
      <LibraryPlacementOverlay
        session={session}
        onClose={closeLibraryPlacement}
      />
    </LibraryPlacementControllerContext.Provider>
  );
}

export function useLibraryPlacementController(): LibraryPlacementController {
  const value = useContext(LibraryPlacementControllerContext);
  if (!value) {
    throw new Error("LibraryPlacementControllerProvider is missing");
  }
  return value;
}
