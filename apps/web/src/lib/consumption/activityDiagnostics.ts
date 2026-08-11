"use client";

import type { ActivityModality } from "./activityContract";

export const ACTIVITY_DIAGNOSTIC_EVENT = "nexus:consumption-activity";

interface ActivityDiagnosticBase {
  readonly platform: "Web";
  readonly modality: ActivityModality;
  readonly count: number;
}

export type ActivityDiagnosticDetail =
  | (ActivityDiagnosticBase & { readonly event: "activity_span_closed" })
  | (ActivityDiagnosticBase & {
      readonly event: "activity_span_enqueued";
      readonly queueAgeMs: number;
    })
  | (ActivityDiagnosticBase & {
      readonly event: "activity_upload_attempted";
      readonly queueAgeMs: number;
    })
  | (ActivityDiagnosticBase & {
      readonly event: "activity_upload_accepted";
      readonly queueAgeMs: number;
      readonly latencyMs: number;
    })
  | (ActivityDiagnosticBase & {
      readonly event: "activity_upload_rejected";
      readonly queueAgeMs: number;
      readonly latencyMs: number;
      readonly reason: string;
    });

export type ActivityDiagnosticEmitter = (
  detail: ActivityDiagnosticDetail,
) => void;

/** Emits only bounded operational fields; payload, media, device, and content are absent. */
export const emitActivityDiagnostic: ActivityDiagnosticEmitter = (detail) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ActivityDiagnosticDetail>(ACTIVITY_DIAGNOSTIC_EVENT, {
      detail,
    }),
  );
  if (detail.event === "activity_upload_rejected") {
    console.warn("consumption_activity", detail);
  }
};
