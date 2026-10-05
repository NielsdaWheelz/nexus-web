import type { Schema } from "@/lib/api/wire";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";

export type MediaRef = string & { readonly __mediaRef: unique symbol };
export type ActivityModality = "Reading" | "Listening" | "Viewing";
export type ActivityDeviceClass = "Desktop" | "Mobile";

/** The capture body the web uploader and the Android app post; the BFF adds `deviceId`. */
export type ActivityRequest = Omit<Schema<"ActivityRecordIn">, "deviceId">;

/** One span body per modality, as the capture body carries it. */
export interface ActivitySpanBodies {
  Reading: Omit<Schema<"ReadingActivitySpanIn">, "captureKey">;
  Listening: Omit<Schema<"ListeningActivitySpanIn">, "captureKey">;
  Viewing: Omit<Schema<"ViewingActivitySpanIn">, "captureKey">;
}

export type ClosedActivitySpan = {
  [M in ActivityModality]: {
    captureKey: string;
    mediaRef: MediaRef;
    modality: M;
    deviceClass: ActivityDeviceClass;
    span: ActivitySpanBodies[M];
  };
}[ActivityModality];

export function parseMediaRef(value: string): MediaRef {
  if (parseResourceRef(value)?.scheme !== "media") {
    throw new Error(`Invalid mediaRef: ${JSON.stringify(value)}`);
  }
  return value as MediaRef;
}
