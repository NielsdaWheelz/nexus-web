"use client";

import { useCallback, useRef } from "react";

export const MAX_VOICE_NOTE_DURATION_MS = 120_000;

export const E_MIC_DENIED = "E_MIC_DENIED";
export const E_MIC_UNAVAILABLE = "E_MIC_UNAVAILABLE";

export interface VoiceRecordingResult {
  blob: Blob;
  durationMs: number;
}

export interface UseVoiceRecorderReturn {
  start: () => Promise<void>;
  stop: () => Promise<VoiceRecordingResult>;
}

export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobEvent["data"][]>([]);
  const startTimeRef = useRef<number>(0);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopResolveRef = useRef<((result: VoiceRecordingResult) => void) | null>(null);
  const stopRejectRef = useRef<((err: Error) => void) | null>(null);

  const stop = useCallback((): Promise<VoiceRecordingResult> => {
    return new Promise((resolve, reject) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        reject(new Error("No active recording"));
        return;
      }

      if (autoStopTimerRef.current !== null) {
        clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }

      stopResolveRef.current = resolve;
      stopRejectRef.current = reject;
      recorder.stop();
    });
  }, []);

  const start = useCallback(async (): Promise<void> => {
    // Clean up any lingering recorder
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          throw Object.assign(new Error("Microphone access denied"), { code: E_MIC_DENIED });
        }
        if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
          throw Object.assign(new Error("Microphone not found"), { code: E_MIC_UNAVAILABLE });
        }
      }
      throw err;
    }

    chunksRef.current = [];
    startTimeRef.current = Date.now();

    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      // Stop all tracks to release the mic
      for (const track of stream.getTracks()) {
        track.stop();
      }

      const durationMs = Date.now() - startTimeRef.current;
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });

      const resolve = stopResolveRef.current;
      stopResolveRef.current = null;
      stopRejectRef.current = null;

      if (resolve) {
        resolve({ blob, durationMs });
      }
    };

    recorder.onerror = () => {
      const reject = stopRejectRef.current;
      stopResolveRef.current = null;
      stopRejectRef.current = null;
      if (reject) {
        reject(new Error("MediaRecorder error"));
      }
    };

    recorder.start();

    // Auto-stop at duration cap
    autoStopTimerRef.current = setTimeout(() => {
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
    }, MAX_VOICE_NOTE_DURATION_MS);
  }, []);

  return { start, stop };
}
