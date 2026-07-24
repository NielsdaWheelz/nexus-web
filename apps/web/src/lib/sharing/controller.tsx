"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import ShareOverlay from "@/components/sharing/ShareOverlay";
import type { ShareOpenOptions, ShareTarget } from "@/lib/sharing/types";

export interface ShareSession {
  key: number;
  target: ShareTarget;
  options: ShareOpenOptions;
}

interface ShareController {
  openShare: (target: ShareTarget, options: ShareOpenOptions) => void;
  closeShare: () => void;
}

const ShareControllerContext = createContext<ShareController | null>(null);

export function ShareControllerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ShareSession | null>(null);

  const openShare = useCallback(
    (target: ShareTarget, options: ShareOpenOptions) => {
      setSession((current) => ({
        key: (current?.key ?? 0) + 1,
        target,
        options,
      }));
    },
    [],
  );
  const closeShare = useCallback(() => setSession(null), []);
  const value = useMemo(
    () => ({ openShare, closeShare }),
    [closeShare, openShare],
  );

  return (
      <ShareControllerContext.Provider value={value}>
        {children}
        <ShareOverlay session={session} onClose={closeShare} />
      </ShareControllerContext.Provider>
  );
}

export function useShareController(): ShareController {
  const value = useContext(ShareControllerContext);
  if (!value) {
    throw new Error("ShareControllerProvider is missing");
  }
  return value;
}
