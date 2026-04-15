"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useReaderProfile } from "./useReaderProfile";
import type {
  ReaderFontFamily,
  ReaderProfile,
  ReaderTheme,
  ReaderViewMode,
} from "./types";
import { DEFAULT_READER_PROFILE } from "./types";

interface ReaderContextValue {
  profile: ReaderProfile;
  loading: boolean;
  error: string | null;
  saving: boolean;
  updateTheme: (theme: ReaderTheme) => void;
  updateFontFamily: (fontFamily: ReaderFontFamily) => void;
  updateFontSize: (fontSizePx: number) => void;
  updateLineHeight: (lineHeight: number) => void;
  updateColumnWidth: (columnWidthCh: number) => void;
  updateFocusMode: (focusMode: boolean) => void;
  updateDefaultViewMode: (viewMode: ReaderViewMode) => void;
}

const ReaderContext = createContext<ReaderContextValue | null>(null);

const NOOP = () => {};

export function ReaderProvider({ children }: { children: ReactNode }) {
  const {
    profile,
    loading,
    error,
    saving,
    updateTheme,
    updateFontFamily,
    updateFontSize,
    updateLineHeight,
    updateColumnWidth,
    updateFocusMode,
    updateDefaultViewMode,
  } = useReaderProfile();

  const value = useMemo<ReaderContextValue>(
    () => ({
      profile: profile ?? DEFAULT_READER_PROFILE,
      loading,
      error,
      saving,
      updateTheme,
      updateFontFamily,
      updateFontSize,
      updateLineHeight,
      updateColumnWidth,
      updateFocusMode,
      updateDefaultViewMode,
    }),
    [
      profile,
      loading,
      error,
      saving,
      updateTheme,
      updateFontFamily,
      updateFontSize,
      updateLineHeight,
      updateColumnWidth,
      updateFocusMode,
      updateDefaultViewMode,
    ]
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
      saving: false,
      updateTheme: NOOP,
      updateFontFamily: NOOP,
      updateFontSize: NOOP,
      updateLineHeight: NOOP,
      updateColumnWidth: NOOP,
      updateFocusMode: NOOP,
      updateDefaultViewMode: NOOP,
    };
  }
  return ctx;
}
