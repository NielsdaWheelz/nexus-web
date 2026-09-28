"use client";

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import LibraryPlacementOverlay from "@/components/libraries/LibraryPlacementOverlay";
import type { Presence } from "@/lib/api/presence";
import type { LibraryPlacementTarget } from "@/lib/libraries/libraryPlacement";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";

export interface LibraryPlacementOpenOptions {
  anchor: ReturnFocusTarget;
  returnFocusFallback: Presence<ReturnFocusTarget>;
  /** Reconciles the subject's action snapshot after a successful placement write. */
  reconcileActions: () => Promise<void>;
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
}

const LibraryPlacementControllerContext = createContext<LibraryPlacementController | null>(null);

/** Owns the app's one placement session: opening replaces it, and closing is always allowed. */
export function LibraryPlacementControllerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<LibraryPlacementSession | null>(null);
  const lastKey = useRef(0);
  const value = useMemo<LibraryPlacementController>(
    () => ({
      openLibraryPlacement(target, options) {
        lastKey.current += 1;
        setSession({ key: lastKey.current, target, options });
      },
    }),
    [],
  );

  return (
    <LibraryPlacementControllerContext.Provider value={value}>
      {children}
      <LibraryPlacementOverlay session={session} onClose={() => setSession(null)} />
    </LibraryPlacementControllerContext.Provider>
  );
}

export function useLibraryPlacementController(): LibraryPlacementController {
  const value = useContext(LibraryPlacementControllerContext);
  if (!value) throw new Error("LibraryPlacementControllerProvider is missing");
  return value;
}
