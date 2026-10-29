"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { copyText } from "@/lib/ui/copyText";

/** Only the invisible outcome is timed; the caller keeps clipboard recovery. */
export function useCopyFeedback(target: unknown) {
  const [success, setSuccess] = useState<{ target: unknown; occurrence: object } | null>(null);
  const current = useRef({ target, generation: 0, timer: null as ReturnType<typeof setTimeout> | null });
  useLayoutEffect(() => {
    const state = current.current;
    state.target = target;
    state.generation++;
    setSuccess(null);
    return () => { state.generation++; if (state.timer !== null) clearTimeout(state.timer); };
  }, [target]);
  const copy = async (text: string) => {
    const state = current.current;
    const generation = ++state.generation;
    if (state.timer !== null) clearTimeout(state.timer);
    setSuccess(null);
    try { await copyText(text); }
    catch (error) {
      if (state.generation !== generation || !Object.is(state.target, target)) return;
      throw error;
    }
    if (state.generation !== generation || !Object.is(state.target, target)) return;
    const next = { target, occurrence: {} };
    setSuccess(next);
    state.timer = setTimeout(() => { if (state.generation === generation) setSuccess(null); }, 1200);
  };
  const occurrence = success !== null && Object.is(success.target, target) ? success.occurrence : null;
  return { copied: occurrence !== null, occurrence, copy };
}
