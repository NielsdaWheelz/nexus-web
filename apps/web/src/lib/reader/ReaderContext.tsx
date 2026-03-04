"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useReaderProfile } from "./useReaderProfile";
import type { ReaderProfile } from "./types";
import { DEFAULT_READER_PROFILE } from "./types";

interface ReaderContextValue {
  profile: ReaderProfile;
  loading: boolean;
  error: string | null;
}

const ReaderContext = createContext<ReaderContextValue | null>(null);

export function ReaderProvider({ children }: { children: ReactNode }) {
  const { profile, loading, error } = useReaderProfile();

  const value = useMemo<ReaderContextValue>(
    () => ({
      profile: profile ?? DEFAULT_READER_PROFILE,
      loading,
      error,
    }),
    [profile, loading, error]
  );

  return (
    <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>
  );
}

export function useReaderContext(): ReaderContextValue {
  const ctx = useContext(ReaderContext);
  if (!ctx) {
    return {
      profile: DEFAULT_READER_PROFILE,
      loading: false,
      error: null,
    };
  }
  return ctx;
}
