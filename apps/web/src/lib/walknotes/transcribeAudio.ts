"use client";

import {
  apiErrorFromResponse,
  decodeApiPayload,
} from "@/lib/api/client";
import {
  expectExactRecord,
  expectNullableNonnegativeInteger,
  expectString,
} from "@/lib/validation";

export function decodeWalknoteTranscriptionResponse(raw: unknown): string {
  const envelope = expectExactRecord(
    raw,
    ["data"],
    "Walknote transcription response",
  );
  const data = expectExactRecord(
    envelope.data,
    ["transcript", "duration_ms"],
    "Walknote transcription response.data",
  );
  const transcript = expectString(
    data.transcript,
    "Walknote transcription response.data.transcript",
  );
  expectNullableNonnegativeInteger(
    data.duration_ms,
    "Walknote transcription response.data.duration_ms",
  );
  return transcript;
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, "recording");
  form.append("content_type", blob.type || "audio/webm");

  const response = await fetch("/api/walknotes/transcribe", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }

  const body: unknown = await response.json();
  return decodeApiPayload(
    body,
    decodeWalknoteTranscriptionResponse,
    "Walknote transcription",
  );
}
