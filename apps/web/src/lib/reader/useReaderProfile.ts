"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { toFeedback } from "@/components/feedback/Feedback";
import type { ReaderFontFamily, ReaderProfile, ReaderTheme } from "./types";
import { DEFAULT_READER_PROFILE } from "./types";

type ApiFetchFn = typeof apiFetch;

interface UseReaderProfileOptions {
  apiFetch?: ApiFetchFn;
  debounceMs?: number;
}

export function useReaderProfile(options: UseReaderProfileOptions = {}) {
  const fetchFn = options.apiFetch ?? apiFetch;
  const debounceMs = options.debounceMs ?? 400;
  const [profile, setProfile] = useState<ReaderProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<ReaderProfile> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFn<{ data: ReaderProfile }>(
        "/api/me/reader-profile"
      );
      setProfile(res.data);
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        setProfile(null);
      } else {
        setError(toFeedback(err, { fallback: "Failed to load reader settings" }).title);
      }
    } finally {
      setLoading(false);
    }
  }, [fetchFn]);

  useEffect(() => {
    load();
  }, [load]);

  const flushPending = useCallback(async () => {
    const payload = pendingRef.current;
    pendingRef.current = null;
    debounceRef.current = null;
    if (!payload) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetchFn<{ data: ReaderProfile }>("/api/me/reader-profile", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setProfile(res.data);
    } catch (err) {
      setError(toFeedback(err, { fallback: "Failed to save reader settings" }).title);
    } finally {
      setSaving(false);
    }
  }, [fetchFn]);

  const save = useCallback(
    (updates: Partial<ReaderProfile>) => {
      pendingRef.current = { ...pendingRef.current, ...updates };
      setProfile((prev) => ({ ...(prev ?? DEFAULT_READER_PROFILE), ...updates }));

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        void flushPending();
      }, debounceMs);
    },
    [debounceMs, flushPending]
  );

  const updateTheme = useCallback(
    (theme: ReaderTheme) => save({ theme }),
    [save]
  );
  const updateFontFamily = useCallback(
    (font_family: ReaderFontFamily) => save({ font_family }),
    [save]
  );
  const updateFontSize = useCallback(
    (font_size_px: number) => save({ font_size_px }),
    [save]
  );
  const updateLineHeight = useCallback(
    (line_height: number) => save({ line_height }),
    [save]
  );
  const updateColumnWidth = useCallback(
    (column_width_ch: number) => save({ column_width_ch }),
    [save]
  );
  const updateFocusMode = useCallback(
    (focus_mode: boolean) => save({ focus_mode }),
    [save]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  return {
    profile,
    loading,
    error,
    saving,
    load,
    save,
    updateTheme,
    updateFontFamily,
    updateFontSize,
    updateLineHeight,
    updateColumnWidth,
    updateFocusMode,
  };
}
