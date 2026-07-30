"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import { transcribeAudio } from "@/lib/walknotes/transcribeAudio";
import { useVoiceRecorder } from "@/lib/walknotes/useVoiceRecorder";
import { useWalknoteSession } from "@/lib/walknotes/walknoteSession";

const HOLD_THRESHOLD_MS = 500;

export interface PlayerCaptureSnapshot {
  readonly mediaId: string;
  readonly positionMs: number;
}

interface HeldCapture {
  readonly kind: "Held";
  readonly snapshot: PlayerCaptureSnapshot;
}

interface PendingCapture {
  readonly kind: "Pending";
  readonly snapshot: PlayerCaptureSnapshot;
}

interface VoiceCapture {
  readonly kind: "Voice";
  readonly waypointId: string;
  phase: "Starting" | "Recording" | "Stopping";
  finishRequested: boolean;
}

type ActiveCapture = PendingCapture | HeldCapture | VoiceCapture;

export interface PlayerCaptureController {
  readonly waypointCount: number;
  readonly isRecording: boolean;
  readonly reviewOpen: boolean;
  readonly announcement: string;
  readonly openReview: () => void;
  readonly closeReview: () => void;
  readonly announceMaterialized: (count: number) => void;
  readonly captureTap: (snapshot: PlayerCaptureSnapshot) => void;
  readonly handlePointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    snapshot: PlayerCaptureSnapshot,
  ) => void;
  readonly handlePointerUp: () => void;
  readonly handlePointerCancel: () => void;
  readonly closeForPlayerDismissal: () => void;
}

/**
 * Owns the one player Capture interaction across every player surface.
 * Timeline leaves pass their exact pointer-down snapshot; this controller never
 * subscribes the surface root to playback cadence.
 */
export function usePlayerCapture(): PlayerCaptureController {
  const { account } = useBillingAccount();
  const session = useWalknoteSession();
  const recorder = useVoiceRecorder();
  const [isRecording, setIsRecording] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCaptureRef = useRef<ActiveCapture | null>(null);
  const canTranscribeRef = useRef(account?.can_transcribe ?? false);
  const sessionRef = useRef(session);
  const recorderRef = useRef(recorder);
  canTranscribeRef.current = account?.can_transcribe ?? false;
  sessionRef.current = session;
  recorderRef.current = recorder;

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current === null) {
      return;
    }
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);

  const finishVoiceCapture = useCallback((capture: VoiceCapture) => {
    if (capture.phase === "Stopping") {
      return;
    }
    capture.phase = "Stopping";
    setIsRecording(false);
    void recorderRef.current
      .stop()
      .then(({ blob }) => {
        if (activeCaptureRef.current === capture) {
          activeCaptureRef.current = null;
        }
        sessionRef.current.updateWaypointVoice(
          capture.waypointId,
          "transcribing",
        );
        setAnnouncement("Transcribing");
        return transcribeAudio(blob);
      })
      .then((text) => {
        sessionRef.current.updateWaypointVoice(
          capture.waypointId,
          "done",
          text,
        );
        setAnnouncement("");
      })
      .catch(() => {
        if (activeCaptureRef.current === capture) {
          activeCaptureRef.current = null;
        }
        sessionRef.current.updateWaypointVoice(capture.waypointId, "failed");
        setAnnouncement("Transcription failed");
      });
  }, []);

  const handlePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLButtonElement>,
      snapshot: PlayerCaptureSnapshot,
    ) => {
      if (activeCaptureRef.current !== null) {
        return;
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Browser test environments may not own a native active pointer.
      }

      const capture: PendingCapture = {
        kind: "Pending",
        snapshot: {
          mediaId: snapshot.mediaId,
          positionMs: Math.max(0, Math.floor(snapshot.positionMs)),
        },
      };
      activeCaptureRef.current = capture;
      clearHoldTimer();
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        if (activeCaptureRef.current !== capture) {
          return;
        }
        if (!canTranscribeRef.current) {
          activeCaptureRef.current = {
            kind: "Held",
            snapshot: capture.snapshot,
          };
          return;
        }

        const waypointId = sessionRef.current.addWaypoint(
          capture.snapshot.mediaId,
          capture.snapshot.positionMs,
        );
        const voiceCapture: VoiceCapture = {
          kind: "Voice",
          waypointId,
          phase: "Starting",
          finishRequested: false,
        };
        activeCaptureRef.current = voiceCapture;
        sessionRef.current.updateWaypointVoice(waypointId, "recording");
        setIsRecording(true);
        setAnnouncement("Recording");

        void recorderRef.current
          .start()
          .then(() => {
            if (activeCaptureRef.current !== voiceCapture) {
              return;
            }
            voiceCapture.phase = "Recording";
            if (voiceCapture.finishRequested) {
              finishVoiceCapture(voiceCapture);
            }
          })
          .catch(() => {
            if (activeCaptureRef.current !== voiceCapture) {
              return;
            }
            activeCaptureRef.current = null;
            sessionRef.current.updateWaypointVoice(waypointId, "failed");
            setIsRecording(false);
            setAnnouncement("Transcription failed");
          });
      }, HOLD_THRESHOLD_MS);
    },
    [clearHoldTimer, finishVoiceCapture],
  );

  const finishPointerInteraction = useCallback(() => {
    clearHoldTimer();
    const capture = activeCaptureRef.current;
    if (capture === null) {
      return;
    }
    if (capture.kind === "Pending" || capture.kind === "Held") {
      activeCaptureRef.current = null;
      sessionRef.current.addWaypoint(
        capture.snapshot.mediaId,
        capture.snapshot.positionMs,
      );
      return;
    }
    if (capture.phase === "Starting") {
      capture.finishRequested = true;
      return;
    }
    if (capture.phase === "Stopping") {
      return;
    }
    finishVoiceCapture(capture);
  }, [clearHoldTimer, finishVoiceCapture]);

  const captureTap = useCallback((snapshot: PlayerCaptureSnapshot) => {
    if (activeCaptureRef.current !== null) return;
    sessionRef.current.addWaypoint(
      snapshot.mediaId,
      Math.max(0, Math.floor(snapshot.positionMs)),
    );
  }, []);

  const handlePointerCancel = useCallback(() => {
    clearHoldTimer();
    const capture = activeCaptureRef.current;
    if (capture === null) {
      return;
    }
    if (capture.kind === "Pending" || capture.kind === "Held") {
      activeCaptureRef.current = null;
      return;
    }
    if (capture.phase === "Starting") {
      capture.finishRequested = true;
      return;
    }
    if (capture.phase === "Stopping") {
      return;
    }
    finishVoiceCapture(capture);
  }, [clearHoldTimer, finishVoiceCapture]);

  const closeForPlayerDismissal = useCallback(() => {
    setReviewOpen(false);
    handlePointerCancel();
    setIsRecording(false);
  }, [handlePointerCancel]);

  useEffect(
    () => () => {
      clearHoldTimer();
      const capture = activeCaptureRef.current;
      if (capture?.kind !== "Voice") {
        activeCaptureRef.current = null;
        return;
      }
      if (capture.phase === "Starting") {
        capture.finishRequested = true;
        return;
      }
      if (capture.phase === "Recording") {
        activeCaptureRef.current = null;
        void recorderRef.current.stop();
      }
    },
    [clearHoldTimer],
  );

  const announceMaterialized = useCallback((count: number) => {
    setAnnouncement(
      count === 1 ? "1 highlight created" : `${count} highlights created`,
    );
  }, []);
  const openReview = useCallback(() => setReviewOpen(true), []);
  const closeReview = useCallback(() => setReviewOpen(false), []);

  return {
    waypointCount: session.waypoints.length,
    isRecording,
    reviewOpen,
    announcement,
    openReview,
    closeReview,
    announceMaterialized,
    captureTap,
    handlePointerDown,
    handlePointerUp: finishPointerInteraction,
    handlePointerCancel,
    closeForPlayerDismissal,
  };
}
