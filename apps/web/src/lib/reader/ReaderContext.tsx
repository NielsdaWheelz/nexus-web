"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useReaderProfile } from "./useReaderProfile";
import type { ReaderProfilePersistence } from "./readerProfileSync";
import type {
  ReaderFocusMode,
  ReaderFontFamily,
  ReaderHyphenation,
  ReaderProfile,
  ReaderTheme,
} from "./types";

/** The public reader-profile capability: semantic intent only, no raw save. */
export interface ReaderProfileCapability {
  /** Optimistic desired profile; drives pixels. */
  profile: ReaderProfile;
  persistence: ReaderProfilePersistence;
  setTheme: (value: ReaderTheme) => void;
  setFontFamily: (value: ReaderFontFamily) => void;
  setFocusMode: (value: ReaderFocusMode) => void;
  setHyphenation: (value: ReaderHyphenation) => void;
  setFontSize: (value: number) => void;
  setLineHeight: (value: number) => void;
  setColumnWidth: (value: number) => void;
  retrySave: () => void;
}

const ReaderContext = createContext<ReaderProfileCapability | null>(null);

export function ReaderProvider({
  children,
  initialProfile,
}: {
  children: ReactNode;
  initialProfile: ReaderProfile;
}) {
  const { profile, persistence, intend, retrySave } = useReaderProfile(initialProfile);

  const value = useMemo<ReaderProfileCapability>(
    () => ({
      profile,
      persistence,
      setTheme: (theme) => intend({ theme }),
      setFontFamily: (font_family) => intend({ font_family }),
      setFocusMode: (focus_mode) => intend({ focus_mode }),
      setHyphenation: (hyphenation) => intend({ hyphenation }),
      setFontSize: (font_size_px) => intend({ font_size_px }),
      setLineHeight: (line_height) => intend({ line_height }),
      setColumnWidth: (column_width_ch) => intend({ column_width_ch }),
      retrySave,
    }),
    [intend, persistence, profile, retrySave],
  );

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}

export function useReaderContext(): ReaderProfileCapability {
  const ctx = useContext(ReaderContext);
  if (!ctx) {
    // The profile is a required bootstrap seed; absence is a wiring defect,
    // never a default.
    throw new Error("useReaderContext requires a ReaderProvider");
  }
  return ctx;
}
