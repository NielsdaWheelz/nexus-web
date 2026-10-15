"use client";

// The app's one "Libraries…" session: opening replaces it, closing is always
// allowed. Anything that files items (an action menu, the Add panel) opens it
// with the items it means.

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import PlacementOverlay from "@/components/libraries/PlacementOverlay";
import type { LibraryPlacementTarget } from "@/lib/libraries/api";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";

export interface LibraryPlacementOpenOptions {
  readonly anchor: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget | null;
}

export interface LibraryPlacementSession {
  readonly key: number;
  readonly targets: readonly LibraryPlacementTarget[];
  readonly options: LibraryPlacementOpenOptions;
}

interface LibraryPlacementController {
  readonly openLibraryPlacement: (
    targets: readonly LibraryPlacementTarget[],
    options: LibraryPlacementOpenOptions,
  ) => void;
}

const Context = createContext<LibraryPlacementController | null>(null);

export function LibraryPlacementControllerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<LibraryPlacementSession | null>(null);
  const lastKey = useRef(0);
  const value = useMemo<LibraryPlacementController>(
    () => ({
      openLibraryPlacement(targets, options) {
        lastKey.current += 1;
        setSession({ key: lastKey.current, targets, options });
      },
    }),
    [],
  );
  return (
    <Context.Provider value={value}>
      {children}
      <PlacementOverlay session={session} onClose={() => setSession(null)} />
    </Context.Provider>
  );
}

export function useLibraryPlacementController(): LibraryPlacementController {
  const value = useContext(Context);
  if (!value) throw new Error("LibraryPlacementControllerProvider is missing");
  return value;
}
