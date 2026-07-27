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
import type { Presence } from "@/lib/api/presence";
import type { LibraryPlacementTarget } from "@/lib/libraries/libraryPlacement";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";

export interface LibraryPlacementOpenOptions {
  anchor: ReturnFocusTarget;
  returnFocusFallback: Presence<ReturnFocusTarget>;
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
  const nextSessionKeyRef = useRef(0);
  const openLibraryPlacement = useCallback(
    (
      target: LibraryPlacementTarget,
      options: LibraryPlacementOpenOptions,
    ) => {
      nextSessionKeyRef.current += 1;
      setSession({ key: nextSessionKeyRef.current, target, options });
    },
    [],
  );
  const closeLibraryPlacement = useCallback(() => setSession(null), []);
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
